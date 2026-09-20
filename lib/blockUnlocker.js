/**
 * Block unlocker for Epic Cash (adapted from cryptonote-nodejs-pool, GPL-2.0).
 *
 * A block candidate (redis zset <coin>:blocks:candidates, score = height, member
 * rewardType:login:hash:time:difficulty:shares:score, written by shares.js when the node answers "blockfound")
 * is settled once the chain is `depth` blocks past it (1440 = coinbase maturity of Epic mainnet):
 *  - the pool wallet holds a CONFIRMED coinbase output at that height -> the block is ours, the reward is the exact value
 *    of that output (Mimblewimble hides amounts, so the wallet is the only source of truth). The node makes the wallet
 *    create a coinbase output for every block template it builds, but only outputs of blocks that really got into the
 *    chain turn from "Unconfirmed" to "Unspent", so an unconfirmed output proves nothing;
 *  - no confirmed output and the header at that height has another hash -> orphaned;
 *  - no confirmed output but the hash matches -> cannot tell yet (wallet not refreshed?): try again later, credit nothing.
 * The reward, minus the pool fee, is split by the round scores into the balances of the miners
 * (redis <coin>:workers:<account>, field `balance`); the payment processor pays them out.
 **/

let async = require('async');

let apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
let walletRpc = require('./walletRpc.js')(config.wallet);
let notifications = require('./notifications.js');
let utils = require('./utils.js');

let slushMiningEnabled = config.poolServer.slushMining && config.poolServer.slushMining.enabled;
let unlockerConfig = config.blockUnlocker;
let depth = unlockerConfig.depth || 1440;
let CONFIRMED = ['Unspent', 'Locked', 'Spent'];

// Initialize log system
let logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

// Developer donation: {"<epicbox address>[.note]": percent of the block reward}. It is paid like any other balance (same minimum,
// same payment processor), shown by the API and by the website, and taken before the miners' shares are computed.
let donations = utils.donationTable(unlockerConfig, function (address) {
	log('error', logSystem, 'Donation entry %s ignored: it needs a valid epicbox address and a percent above 0 up to 10', [address]);
});
let donationPercent = Object.keys(donations).reduce(function (sum, account) { return sum + donations[account]; }, 0);

log('info', logSystem, 'Started (depth %d blocks, pool fee %s%%, developer donation %s%%)', [depth, unlockerConfig.poolFee || 0, donationPercent]);

/**
 * Confirmed coinbase outputs of the wallet at the given heights: {height: value}
 **/
function coinbaseRewards (heights, callback) {
	let wanted = {};
	heights.forEach(function (h) { wanted[h] = true; });
	let found = {};
	let offset = 0;
	let limit = 500;

	function page () {
		walletRpc.outputs({includeSpent: true, limit: limit, offset: offset}, function (error, outputs, pager) {
			if (error) return callback(error);
			outputs.forEach(function (o) {
				if (!o.isCoinbase || CONFIRMED.indexOf(o.status) === -1 || !wanted[o.height]) return;
				if (found[o.height] && found[o.height] !== o.value) {
					log('warn', logSystem, 'More than one confirmed coinbase output at height %d (%d and %d), taking the larger', [o.height, found[o.height], o.value]);
				}
				found[o.height] = Math.max(found[o.height] || 0, o.value);
			});
			offset += limit;
			if (!pager || offset >= pager.total_records || outputs.length === 0) return callback(null, found);
			page();
		});
	}

	page();
}

function feePercentOf (block) {
	if (block.rewardType === 'solo') {
		return (unlockerConfig.soloFee >= 0 ? unlockerConfig.soloFee : (unlockerConfig.poolFee > 0 ? unlockerConfig.poolFee : 0)) / 100;
	}
	return (unlockerConfig.poolFee > 0 ? unlockerConfig.poolFee : 0) / 100;
}

/**
 * Run block unlocker
 **/
function runInterval () {
	async.waterfall([

		// All block candidates in redis
		function (callback) {
			redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function (error, results) {
				if (error) {
					log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
					callback(true);
					return;
				}
				if (results.length === 0) {
					log('info', logSystem, 'No blocks candidates in redis');
					callback(true);
					return;
				}

				let blocks = [];
				for (let i = 0; i < results.length; i += 2) {
					let parts = results[i].split(':');
					blocks.push({
						serialized: results[i],
						height: parseInt(results[i + 1]),
						rewardType: parts[0],
						login: parts[1],
						hash: parts[2],
						time: parts[3],
						difficulty: parts[4],
						shares: parts[5],
						score: parts.length >= 7 ? parts[6] : parts[5]
					});
				}
				callback(null, blocks);
			});
		},

		// Which of them are `depth` blocks behind the tip
		function (blocks, callback) {
			apiInterfaces.nodeApi('/v1/chain', function (error, chain) {
				if (error || !chain || typeof chain.height !== 'number') {
					log('error', logSystem, 'Error getting the chain tip %j', [error ? String(error) : 'bad reply']);
					callback(true);
					return;
				}
				let ripe = blocks.filter(function (block) { return chain.height - block.height >= depth; });
				if (ripe.length === 0) {
					log('info', logSystem, 'No pending blocks are unlocked yet (%d pending, chain height %d, first one due at %d)',
						[blocks.length, chain.height, Math.min.apply(null, blocks.map(function (b) { return b.height; })) + depth]);
					callback(true);
					return;
				}
				callback(null, ripe);
			});
		},

		// Decide for each: ours (reward from the wallet), orphaned, or not decidable yet
		function (blocks, callback) {
			coinbaseRewards(blocks.map(function (b) { return b.height; }), function (error, rewards) {
				if (error) {
					log('error', logSystem, 'Error reading the coinbase outputs of the wallet %j', [String(error)]);
					callback(true);
					return;
				}

				async.filter(blocks, function (block, mapCback) {
					if (rewards[block.height]) {
						block.orphaned = 0;
						block.reward = rewards[block.height];
						return mapCback(true);
					}

					apiInterfaces.nodeApi('/v1/headers/' + block.height, function (error, header) {
						if (error || !header || !header.hash) {
							log('error', logSystem, 'Error getting the header at height %d %j', [block.height, error ? String(error) : 'bad reply']);
							return mapCback(false);
						}
						if (header.hash !== block.hash) {
							block.orphaned = 1;
							block.reward = 0;
							return mapCback(true);
						}
						log('error', logSystem, 'Block %d (%s) is on the chain but the wallet has no confirmed coinbase output for it yet: waiting', [block.height, block.hash]);
						mapCback(false);
					});
				}, function (decided) {
					if (decided.length === 0) {
						callback(true);
						return;
					}
					callback(null, decided);
				});
			});
		},

		// Round scores of the decided blocks
		function (blocks, callback) {
			let redisCommands = blocks.map(function (block) {
				return ['hgetall', config.coin + ':scores:' + (block.rewardType === 'prop' ? 'prop' : 'solo') + ':round' + block.height];
			});

			redisClient.multi(redisCommands).exec(function (error, replies) {
				if (error) {
					log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
					callback(true);
					return;
				}
				for (let i = 0; i < replies.length; i++) {
					blocks[i].workerScores = replies[i];
				}
				callback(null, blocks);
			});
		},

		// Orphaned blocks: forget the round
		function (blocks, callback) {
			let orphanCommands = [];
			blocks.forEach(function (block) {
				if (!block.orphaned) return;
				orphanCommands.push(['del', config.coin + ':scores:solo:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':shares_actual:solo:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.hash, block.time, block.difficulty, block.shares, block.orphaned
				].join(':')]);

				// without slush weighting the scores of the lost round go back into the current one
				if (block.workerScores && !slushMiningEnabled && block.rewardType === 'prop') {
					Object.keys(block.workerScores).forEach(function (worker) {
						orphanCommands.push(['hincrbyfloat', config.coin + ':scores:prop:roundCurrent', worker, block.workerScores[worker]]);
					});
				}

				log('warn', logSystem, 'Block %d (%s) is orphaned', [block.height, block.hash]);
				notifications.sendToAll('blockOrphaned', {'HEIGHT': block.height, 'HASH': block.hash});
			});

			if (orphanCommands.length === 0) return callback(null, blocks);

			redisClient.multi(orphanCommands).exec(function (error) {
				if (error) {
					log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
					callback(true);
					return;
				}
				callback(null, blocks);
			});
		},

		// Our blocks: credit the miners
		function (blocks, callback) {
			let commands = [];
			let payments = {};
			let unlocked = 0;

			blocks.forEach(function (block) {
				if (block.orphaned) return;
				unlocked++;

				commands.push(['del', config.coin + ':scores:solo:round' + block.height]);
				commands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				commands.push(['del', config.coin + ':shares_actual:solo:round' + block.height]);
				commands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				commands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				commands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.hash, block.time, block.difficulty, block.shares, block.orphaned, block.reward
				].join(':')]);

				let networkFee = unlockerConfig.networkFee > 0 ? block.reward * unlockerConfig.networkFee / 100 : 0;
				let distributable = block.reward - networkFee;
				let feePercent = feePercentOf(block);
				let finderPercent = block.rewardType === 'prop' && unlockerConfig.finderReward > 0 ? unlockerConfig.finderReward / 100 : 0;
				let finderReward = Math.floor(distributable * finderPercent);
				let reward = Math.floor(distributable - distributable * (feePercent + finderPercent + donationPercent / 100));

				Object.keys(donations).forEach(function (account) {
					let amount = Math.floor(distributable * donations[account] / 100);
					payments[account] = (payments[account] || 0) + amount;
					log('info', logSystem, 'Block %d: developer donation %s%% = %d to %s', [block.height, donations[account], amount, account]);
				});

				log('info', logSystem, 'Unlocked %s block %d: reward %d, pool fee %d%%, miners get %d, finder bonus %d',
					[block.rewardType.toUpperCase(), block.height, block.reward, feePercent * 100, reward, finderReward]);

				if (block.rewardType === 'solo') {
					payments[block.login] = (payments[block.login] || 0) + reward;
				} else if (block.workerScores) {
					let totalScore = parseFloat(block.score);
					Object.keys(block.workerScores).forEach(function (worker) {
						let part = Math.floor(reward * (parseFloat(block.workerScores[worker]) / totalScore));
						payments[worker] = (payments[worker] || 0) + part + (block.login === worker ? finderReward : 0);
					});
				}

				notifications.sendToAll('blockUnlocked', {'HEIGHT': block.height, 'HASH': block.hash, 'REWARD': utils.getReadableCoins(block.reward)});
			});

			Object.keys(payments).forEach(function (worker) {
				let amount = Math.floor(payments[worker]);
				if (amount > 0) commands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', amount]);
			});

			if (commands.length === 0) {
				callback(true);
				return;
			}

			// one transaction: the candidate leaves the list in the same step in which the balances grow
			redisClient.multi(commands).exec(function (error) {
				if (error) {
					log('error', logSystem, 'Error with unlocking blocks %j', [error]);
					callback(true);
					return;
				}
				log('info', logSystem, 'Unlocked %d blocks and updated balances of %d accounts', [unlocked, Object.keys(payments).length]);
				callback(null);
			});
		}
	], function () {
		setTimeout(runInterval, unlockerConfig.interval * 1000);
	});
}

runInterval();
