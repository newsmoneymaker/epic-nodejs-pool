/**
 * Payment processor for Epic Cash (adapted from cryptonote-nodejs-pool, GPL-2.0).
 *
 * Mimblewimble payments are interactive: the pool wallet builds a transaction and sends it over epicbox to the miner's
 * wallet, the miner's wallet has to be online to answer, and only then the transaction is finalized and posted (by the
 * epic-wallet-epicbox service). So a payout is not a single step and is tracked in redis:
 *
 *   balance -> [debit + record in <coin>:payments:pending, state "sending"] -> wallet init_send_tx over epicbox
 *           -> state "sent" (slate id known) -> wallet reports the transaction confirmed -> paid
 *           -> or: cancelled / not answered within pendingTimeoutHours -> the amount goes back to the balance.
 *
 * Safety rules: the balance is debited BEFORE anything is sent (a crash can lose a payout attempt, never double it);
 * an attempt whose outcome is unknown ("sending" for more than two minutes) is matched against the wallet's transaction
 * log (amount, destination, time) and only refunded when the wallet has no such transaction; the transaction gets a
 * time-to-live equal to the timeout, so a late answer of the miner cannot be finalized after the refund.
 * An account with an open payout is skipped. Deposit notes (exchange customers) travel as the slate message.
 *
 * config.payments: enabled, dryRun (true = only log what would be paid), interval (s), minPayment, maxTransactionAmount,
 * maxPaymentsPerRound, minConfirmations, pendingTimeoutHours, reserve (kept in the wallet for fees), onlyAccounts (if
 * not empty only these accounts are paid: for rehearsals), stopFile (emergency brake, see below).
 **/

let async = require('async');
let crypto = require('crypto');
let fs = require('fs');
let path = require('path');

let walletRpc = require('./walletRpc.js')(config.wallet);
let utils = require('./utils.js');

let logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

let pc = config.payments;
let interval = (pc.interval || 300) * 1000;
let minConfirmations = pc.minConfirmations || 10;
let timeoutHours = pc.pendingTimeoutHours || 48;
let reserve = pc.reserve >= 0 ? pc.reserve : 5000000;
let maxPerRound = pc.maxPaymentsPerRound || 10;
let dryRun = pc.dryRun !== false;              // anything but an explicit false means: do not send
let onlyAccounts = pc.onlyAccounts || [];
// Emergency brake: while this file exists no NEW payout is started (payouts already in flight are still settled).
// deployment/pause-payments.sh creates it, deployment/resume-payments.sh removes it. Checked before every single payout.
let stopFile = pc.stopFile || path.join(__dirname, '..', 'STOP_PAYMENTS');
let paused = function () { return fs.existsSync(stopFile); };
let UNKNOWN_AFTER = (pc.unknownAfterSeconds || 120) * 1000;   // a "sending" record older than this is reconciled with the wallet

let isSentTx = function (tx) { return /^TxSent/.test(tx.tx_type); };          // TxSent, TxSentMempool, TxSentCancelled
let isCancelledTx = function (tx) { return /^TxSent.*Cancelled$/.test(tx.tx_type); };

let pendingKey = config.coin + ':payments:pending';
let workerKey = function (account) { return config.coin + ':workers:' + account; };
let coins = function (amount) { return utils.getReadableCoins(amount); };

log('info', logSystem, 'Started%s: min payment %s, max per transaction %s, at most %d per round, every %ds',
	[dryRun ? ' in DRY RUN mode (nothing is sent)' : '', coins(pc.minPayment), coins(pc.maxTransactionAmount || 0), maxPerRound, interval / 1000]);

/**
 * Bookkeeping in redis (every change is one transaction)
 **/
function savePending (entry, callback) {
	redisClient.hset(pendingKey, entry.id, JSON.stringify(entry), callback);
}

function refund (entry, reason, callback) {
	log('warn', logSystem, 'Payout %s of %s to %s is returned to the balance: %s', [entry.id, coins(entry.amount), entry.account, reason]);
	redisClient.multi([
		['hincrby', workerKey(entry.account), 'balance', entry.amount],
		['hincrby', workerKey(entry.account), 'pending', -entry.amount],
		['hdel', pendingKey, entry.id]
	]).exec(function (error) {
		if (error) log('error', logSystem, 'Could not return payout %s to the balance %j', [entry.id, error]);
		callback();
	});
}

function complete (entry, tx, callback) {
	let now = Math.floor(Date.now() / 1000);
	let fee = tx && tx.fee ? parseInt(tx.fee) : (entry.fee || 0);
	// "hash" of a payment = the kernel excess of the transaction (that is what the blockchain knows; the slate id does not
	// appear on chain); the explorer shows transactions inside their block, so the height of that block is the link target
	let kernel = (tx && tx.kernel_excess) || entry.slateId;
	let height = (tx && tx.confirmation_height) || '';
	let member = [kernel, entry.amount, fee, 0, 1, height].join(':');
	let memberOwn = [kernel, entry.amount, fee, 0, '', height].join(':');
	log('info', logSystem, 'Paid %s to %s (slate %s, fee %s)', [coins(entry.amount), entry.account, entry.slateId, coins(fee)]);
	redisClient.multi([
		['hincrby', workerKey(entry.account), 'pending', -entry.amount],
		['hincrby', workerKey(entry.account), 'paid', entry.amount],
		['hdel', pendingKey, entry.id],
		['zadd', config.coin + ':payments:all', now, member],
		['zadd', config.coin + ':payments:' + entry.account, now, memberOwn]
	]).exec(function (error) {
		if (error) log('error', logSystem, 'Could not record the payment %s %j', [entry.id, error]);
		callback();
	});
}

/**
 * Step 1: settle what is in flight
 **/
function reconcileEntry (entry, callback) {
	let age = Date.now() - entry.ts;

	// The outcome of the send call is unknown (crash, timeout, error): look for the transaction in the wallet log
	if (entry.state === 'sending') {
		if (age < UNKNOWN_AFTER) return callback();
		walletRpc.txs({limit: 100, order: 'desc'}, function (error, txs) {
			if (error) {
				log('error', logSystem, 'Cannot reconcile payout %s: %s', [entry.id, String(error)]);
				return callback();
			}
			let match = txs.find(function (tx) {
				if (!isSentTx(tx)) return false;
				if (Date.parse(tx.creation_ts) < entry.ts - 60000) return false;
				if (tx.public_addr && tx.public_addr !== entry.dest) return false;
				let fee = tx.fee ? parseInt(tx.fee) : 0;
				return parseInt(tx.amount_debited) - parseInt(tx.amount_credited) - fee === entry.amount;
			});
			if (!match) return refund(entry, 'the wallet has no such transaction', callback);
			if (isCancelledTx(match)) return refund(entry, 'the transaction was cancelled', callback);
			entry.state = 'sent';
			entry.slateId = match.tx_slate_id;
			entry.fee = match.fee ? parseInt(match.fee) : 0;
			log('info', logSystem, 'Payout %s found in the wallet log as slate %s', [entry.id, entry.slateId]);
			savePending(entry, function () { callback(); });
		});
		return;
	}

	walletRpc.txs({slateId: entry.slateId}, function (error, txs) {
		if (error) {
			log('error', logSystem, 'Cannot read the transaction %s: %s', [entry.slateId, String(error)]);
			return callback();
		}
		let tx = txs.find(isSentTx);
		if (!tx) {
			log('error', logSystem, 'Payout %s: slate %s is not in the wallet log, leaving it for a manual check', [entry.id, entry.slateId]);
			return callback();
		}
		if (isCancelledTx(tx)) return refund(entry, 'the transaction was cancelled', callback);
		if (tx.confirmed) return complete(entry, tx, callback);

		if (age > timeoutHours * 3600 * 1000) {
			walletRpc.cancelTx(entry.slateId, function (error) {
				if (error) {
					log('error', logSystem, 'Cannot cancel the transaction %s: %s', [entry.slateId, String(error)]);
					return callback();
				}
				refund(entry, 'no answer within ' + timeoutHours + ' hours, transaction cancelled', callback);
			});
			return;
		}
		callback();
	});
}

function reconcile (callback) {
	redisClient.hgetall(pendingKey, function (error, all) {
		if (error) {
			log('error', logSystem, 'Cannot read the open payouts %j', [error]);
			return callback(true);
		}
		let entries = Object.keys(all || {}).map(function (id) { return JSON.parse(all[id]); });
		if (entries.length) log('info', logSystem, '%d payout(s) in flight', [entries.length]);
		async.eachSeries(entries, reconcileEntry, function () { callback(null); });
	});
}

/**
 * Step 2: new payouts
 **/
function payOne (entry, budget, callback) {
	let account = entry.account;
	redisClient.multi([
		['hincrby', workerKey(account), 'balance', -entry.amount],
		['hincrby', workerKey(account), 'pending', entry.amount],
		['hset', pendingKey, entry.id, JSON.stringify(entry)]
	]).exec(function (error) {
		if (error) {
			log('error', logSystem, 'Could not book the payout %s %j', [entry.id, error]);
			return callback();
		}

		walletRpc.sendEpicbox({
			amount: entry.amount,
			dest: entry.dest,
			message: entry.note,
			ttlBlocks: timeoutHours * 60,
			minConfirmations: minConfirmations
		}, function (error, slate) {
			if (error && /NotEnoughFunds/.test(String(error))) {
				// The wallet's outputs are locked by an unconfirmed payout (its change is not spendable yet). Nothing was sent.
				log('info', logSystem, 'The wallet cannot fund %s to %s yet (waiting for the change of the previous payout to confirm)', [coins(entry.amount), entry.dest]);
				return refund(entry, 'no spendable funds in the wallet at the moment', callback);
			}
			if (error || !slate || !slate.id) {
				// outcome unknown: the record stays in state "sending" and is reconciled with the wallet log later
				log('error', logSystem, 'Sending %s to %s failed or is unclear: %s (the record is kept, it is checked against the wallet)', [coins(entry.amount), entry.dest, String(error || 'no slate')]);
				return callback();
			}
			entry.state = 'sent';
			entry.slateId = slate.id;
			entry.fee = slate.fee ? parseInt(slate.fee) : 0;
			log('info', logSystem, 'Sent %s to %s%s over epicbox, slate %s, fee %s: waiting for the answer of the miner\'s wallet',
				[coins(entry.amount), entry.dest, entry.note ? ' (note ' + entry.note + ')' : '', entry.slateId, coins(entry.fee)]);
			savePending(entry, function () { callback(); });
		});
	});
}

function newPayouts (callback) {
	if (paused()) {
		log('warn', logSystem, 'PAUSED: %s exists, no new payouts are started', [stopFile]);
		return callback(null);
	}

	redisClient.keys(workerKey('*'), function (error, keys) {
		if (error) {
			log('error', logSystem, 'Cannot list the accounts %j', [error]);
			return callback(true);
		}
		let commands = keys.map(function (k) { return ['hmget', k, 'balance', 'pending', 'minPayoutLevel']; });
		redisClient.multi(commands).exec(function (error, replies) {
			if (error) {
				log('error', logSystem, 'Cannot read the balances %j', [error]);
				return callback(true);
			}

			let due = [];
			keys.forEach(function (key, i) {
				let account = key.substring((config.coin + ':workers:').length);
				let balance = parseInt(replies[i][0]) || 0;
				let pending = parseInt(replies[i][1]) || 0;
				let level = Math.max(pc.minPayment, parseInt(replies[i][2]) || 0);
				if (pending > 0 || balance < level) return;
				if (onlyAccounts.length && onlyAccounts.indexOf(account) === -1) return;
				let amount = Math.min(balance, pc.maxTransactionAmount || balance);
				due.push({account: account, amount: amount});
			});

			if (due.length === 0) {
				log('info', logSystem, 'Nobody is due for a payment');
				return callback(null);
			}

			due.sort(function (a, b) { return b.amount - a.amount; });
			due = due.slice(0, maxPerRound);

			if (dryRun) {
				due.forEach(function (d) {
					let parts = utils.splitMinerAccount(d.account);
					log('info', logSystem, '[dry run] would pay %s to %s%s', [coins(d.amount), parts.address, parts.note ? ' (note ' + parts.note + ')' : '']);
				});
				return callback(null);
			}

			walletRpc.summary(minConfirmations, function (error, wallet) {
				if (error) {
					log('error', logSystem, 'Cannot read the wallet balance: %s', [String(error)]);
					return callback(true);
				}
				let budget = wallet.spendable - reserve;
				log('info', logSystem, 'Wallet: %s spendable (%s kept in reserve), %d account(s) due', [coins(wallet.spendable), coins(reserve), due.length]);

				async.eachSeries(due, function (d, next) {
					if (paused()) {
						log('warn', logSystem, 'PAUSED: %s appeared, the remaining payouts of this round are skipped', [stopFile]);
						return next();
					}
					if (d.amount > budget) {
						log('warn', logSystem, 'Not enough spendable funds for %s to %s (budget %s)', [coins(d.amount), d.account, coins(Math.max(budget, 0))]);
						return next();
					}
					budget -= d.amount;
					let parts = utils.splitMinerAccount(d.account);
					payOne({
						id: crypto.randomBytes(6).toString('hex'),
						account: d.account,
						dest: parts.address,
						note: parts.note,
						amount: d.amount,
						ts: Date.now(),
						state: 'sending'
					}, budget, next);
				}, function () { callback(null); });
			});
		});
	});
}

/**
 * Run payment processor
 **/
function runInterval () {
	async.waterfall([reconcile, newPayouts], function () {
		setTimeout(runInterval, interval);
	});
}

runInterval();
