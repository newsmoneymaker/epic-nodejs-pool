/**
 * Client of the epic-wallet Owner API (JSON-RPC 2.0 at /v2/owner, HTTP basic auth). The wallet runs as the systemd
 * unit epic-wallet-owner (127.0.0.1:3420). Amounts are atomic units (1 EPIC = 1e8); the wallet sends them as strings.
 *
 * config.wallet = {host, port, secretFile, user?}
 **/
let fs = require('fs');
let http = require('http');

module.exports = function (walletConfig) {
	let authHeader = null;

	function auth () {
		if (!authHeader) {
			let secret = fs.readFileSync(walletConfig.secretFile, 'utf8').trim();
			authHeader = 'Basic ' + Buffer.from((walletConfig.user || 'epic') + ':' + secret).toString('base64');
		}
		return authHeader;
	}

	/** One JSON-RPC call. callback(error, result) with the value of {"Ok": value} unwrapped. */
	function call (method, params, callback, timeoutMs) {
		let called = false;
		function done (error, result) {
			if (called) return;
			called = true;
			callback(error, result);
		}

		let body;
		try {
			body = JSON.stringify({jsonrpc: '2.0', id: 1, method: method, params: params});
			auth();
		} catch (e) {
			return done(e);
		}

		let request = http.request({
			host: walletConfig.host || '127.0.0.1',
			port: walletConfig.port || 3420,
			path: '/v2/owner',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				'Authorization': authHeader
			}
		}, function (response) {
			let data = '';
			response.setEncoding('utf8');
			response.on('data', function (chunk) { data += chunk; });
			response.on('end', function () {
				if (response.statusCode !== 200) return done(new Error('wallet HTTP ' + response.statusCode));
				let reply;
				try {
					reply = JSON.parse(data);
				} catch (e) {
					return done(new Error('wallet reply is not JSON'));
				}
				if (reply.error) return done(new Error('wallet ' + method + ': ' + (reply.error.message || JSON.stringify(reply.error))));
				let result = reply.result;
				if (result && typeof result === 'object' && 'Err' in result) return done(new Error('wallet ' + method + ': ' + JSON.stringify(result.Err)));
				done(null, result && typeof result === 'object' && 'Ok' in result ? result.Ok : result);
			});
		});
		request.setTimeout(timeoutMs || 30000, function () {
			request.destroy();
			done(new Error('wallet ' + method + ': timeout'));
		});
		request.on('error', function (e) { done(e); });
		request.end(body);
	}

	return {
		call: call,

		/** {height, spendable, awaitingConfirmation, locked, total} */
		summary: function (minConfirmations, callback) {
			call('retrieve_summary_info', {refresh_from_node: true, minimum_confirmations: minConfirmations}, function (error, result) {
				if (error) return callback(error);
				let s = result && result[1];
				if (!s) return callback(new Error('wallet summary: unexpected reply'));
				callback(null, {
					height: parseInt(s.last_confirmed_height),
					spendable: parseInt(s.amount_currently_spendable),
					awaitingConfirmation: parseInt(s.amount_awaiting_confirmation),
					locked: parseInt(s.amount_locked),
					total: parseInt(s.total)
				});
			});
		},

		/** Transactions of the wallet log; opts: {slateId, limit, offset, order:'asc'|'desc', refresh} */
		txs: function (opts, callback) {
			call('retrieve_txs', {
				refresh_from_node: opts.refresh !== false,
				tx_id: null,
				tx_slate_id: opts.slateId || null,
				limit: opts.limit || 100,
				offset: opts.offset || 0,
				sort_order: opts.order || 'desc'
			}, function (error, result) {
				if (error) return callback(error);
				callback(null, (result && result.txs) || [], result && result.pager);
			});
		},

		/** Outputs of the wallet; opts: {includeSpent, limit, offset, refresh}. Returns [{value, height, lockHeight, status, isCoinbase}] */
		outputs: function (opts, callback) {
			call('retrieve_outputs', {
				include_spent: !!opts.includeSpent,
				refresh_from_node: opts.refresh !== false,
				tx_id: null,
				limit: opts.limit || 500,
				offset: opts.offset || 0,
				sort_order: 'desc'
			}, function (error, result) {
				if (error) return callback(error);
				let list = ((result && result.outputs) || []).map(function (item) {
					let o = item.output;
					return {
						value: parseInt(o.value),
						height: parseInt(o.height),
						lockHeight: parseInt(o.lock_height),
						status: o.status,
						isCoinbase: !!o.is_coinbase
					};
				});
				callback(null, list, result && result.pager);
			});
		},

		/**
		 * Build a payment and send it over epicbox in one call (the wallet publishes the slate; the epic-wallet-epicbox
		 * service finalizes and posts the transaction when the receiver answers).
		 * args: {amount, dest, message, ttlBlocks, minConfirmations}; callback(error, slate) with slate.id and slate.fee
		 **/
		sendEpicbox: function (args, callback) {
			call('init_send_tx', {
				args: {
					src_acct_name: null,
					amount: String(args.amount),
					minimum_confirmations: args.minConfirmations || 10,
					max_outputs: 500,
					num_change_outputs: 1,
					selection_strategy_is_use_all: false,
					message: args.message || null,
					target_slate_version: null,
					payment_proof_recipient_address: null,
					ttl_blocks: args.ttlBlocks || null,
					send_args: {method: 'epicbox', dest: args.dest, finalize: true, post_tx: true, fluff: false}
				}
			}, callback, 120000);
		},

		cancelTx: function (slateId, callback) {
			call('cancel_tx', {tx_id: null, tx_slate_id: slateId}, callback);
		}
	};
};
