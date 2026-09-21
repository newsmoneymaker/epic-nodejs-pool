/**
 * Epic Cash Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Share accounting. Writes accepted shares / block candidates to Redis using the
 * same key layout as cryptonote-nodejs-pool, so api.js, blockUnlocker.js and
 * paymentProcessor.js keep working on the same data.
 *
 * Epic has three PoW families with unrelated difficulty units (cuckoo / randomx /
 * progpow), so raw share difficulties are not comparable. Every share is therefore
 * weighted by the probability it has of being a full block:
 *
 *     weight = minShareDifficulty / blockDifficulty   (of the share's own algorithm)
 *
 * scaled by BLOCK_SCALE and rounded to an integer. A "block" is BLOCK_SCALE units,
 * so round effort = sum(weights) / BLOCK_SCALE, regardless of the algorithms used.
 **/

let coin = config.coin;
let slushCfg = config.poolServer.slushMining;
let slushMiningEnabled = slushCfg && slushCfg.enabled;
let cleanupInterval = config.redis.cleanupInterval && config.redis.cleanupInterval > 0 ? config.redis.cleanupInterval : 15;

const BLOCK_SCALE = 1e9;
exports.BLOCK_SCALE = BLOCK_SCALE;

/**
 * Convert a share to its scaled weight. Returns 0 when it cannot be computed.
 **/
exports.shareWeight = function (minShareDifficulty, blockDifficulty) {
	if (!(minShareDifficulty > 0) || !(blockDifficulty > 0)) return 0;
	let ratio = Math.min(1, minShareDifficulty / blockDifficulty);
	return Math.max(1, Math.round(ratio * BLOCK_SCALE));
};

/**
 * Make sure the keys that other modules expect to exist are there.
 * The slush-mining script does `now - hget(stats, lastBlockFound)` and would fail on a nil.
 **/
exports.init = function () {
	redisClient.hsetnx(coin + ':stats', 'lastBlockFound', Date.now(), function (err) {
		if (err) log('error', 'shares', 'Failed to init lastBlockFound: %j', [err]);
	});
};

/**
 * Record an accepted share.
 *
 * share = {
 *   login, workerName, ip, rewardType ('prop'|'solo'),
 *   algo, height, rawDifficulty, weight,
 *   blockCandidate (bool), hash (hex, for candidates)
 * }
 **/
exports.record = function (share, callback) {
	callback = callback || function () {};
	let dateNow = Date.now();
	let dateNowSeconds = dateNow / 1000 | 0;
	let login = share.login;
	let rewardType = share.rewardType;
	let weight = share.weight;
	let height = share.height;
	let workerName = share.workerName;

	let updateScore;
	if (slushMiningEnabled) {
		// Older shares of a round weigh less than newer ones (anti pool-hopping).
		// Done in one Lua script so a block found in between cannot skew the score.
		updateScore = ['eval', `
			local age = (ARGV[3] - redis.call('hget', KEYS[2], 'lastBlockFound')) / 1000
			-- cap the exponent: a small pool can go days without a block, exp() must not overflow
			local score = string.format('%.17g', ARGV[2] * math.exp(math.min(age / ARGV[4], 600)))
			redis.call('hincrbyfloat', KEYS[1], ARGV[1], score)
			return {score, tostring(age)}
			`,
			2, coin + ':scores:' + rewardType + ':roundCurrent', coin + ':stats',
			login, weight, dateNow, slushCfg.weight
		];
	} else {
		updateScore = ['hincrbyfloat', `${coin}:scores:${rewardType}:roundCurrent`, login, weight];
	}

	let redisCommands = [
		updateScore,
		['hincrby', `${coin}:shares_actual:${rewardType}:roundCurrent`, login, weight],
		// hashrate zset keeps the raw difficulty, tagged with the algorithm
		['zadd', `${coin}:hashrate`, dateNowSeconds, [share.rawDifficulty, login, dateNow, rewardType, share.algo].join(':')],
		['hincrby', `${coin}:workers:${login}`, 'hashes', share.rawDifficulty],
		['hset', `${coin}:workers:${login}`, 'lastShare', dateNowSeconds],
		['expire', `${coin}:workers:${login}`, (86400 * cleanupInterval)],
		['expire', `${coin}:payments:${login}`, (86400 * cleanupInterval)]
	];

	if (workerName) {
		let uw = `${coin}:unique_workers:${login}~${workerName}`;
		redisCommands.push(['zadd', `${coin}:hashrate`, dateNowSeconds, [share.rawDifficulty, login + '~' + workerName, dateNow, rewardType, share.algo].join(':')]);
		redisCommands.push(['hincrby', uw, 'hashes', share.rawDifficulty]);
		redisCommands.push(['hset', uw, 'lastShare', dateNowSeconds]);
		redisCommands.push(['expire', uw, (86400 * cleanupInterval)]);
	}

	if (share.blockCandidate) {
		redisCommands.push(['hset', `${coin}:stats`, `lastBlockFound${rewardType}`, dateNow]);
		redisCommands.push(['hset', `${coin}:stats`, 'lastBlockFound', dateNow]);
		redisCommands.push(['rename', `${coin}:scores:prop:roundCurrent`, `${coin}:scores:prop:round${height}`]);
		redisCommands.push(['rename', `${coin}:scores:solo:roundCurrent`, `${coin}:scores:solo:round${height}`]);
		redisCommands.push(['rename', `${coin}:shares_actual:prop:roundCurrent`, `${coin}:shares_actual:prop:round${height}`]);
		redisCommands.push(['rename', `${coin}:shares_actual:solo:roundCurrent`, `${coin}:shares_actual:solo:round${height}`]);
		if (rewardType === 'prop') {
			redisCommands.push(['hgetall', `${coin}:scores:prop:round${height}`]);
			redisCommands.push(['hgetall', `${coin}:shares_actual:prop:round${height}`]);
		} else {
			redisCommands.push(['hget', `${coin}:scores:solo:round${height}`, login]);
			redisCommands.push(['hget', `${coin}:shares_actual:solo:round${height}`, login]);
		}
	}

	redisClient.multi(redisCommands).exec(function (err, replies) {
		if (err) {
			log('error', 'shares', 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
			return callback(err);
		}

		if (slushMiningEnabled) {
			let score = parseFloat(replies[0][0]);
			let age = parseFloat(replies[0][1]);
			log('info', 'shares', 'Submitted score %d for weight %d and round age %ds', [score, weight, age]);
		}

		if (share.blockCandidate) {
			let workerScores = replies[replies.length - 2];
			let workerShares = replies[replies.length - 1];
			let totalScore = 0;
			let totalShares = 0;
			if (rewardType === 'solo') {
				totalScore = parseFloat(workerScores) || 0;
				totalShares = parseInt(workerShares) || 0;
			} else {
				totalScore = Object.keys(workerScores || {}).reduce((p, c) => p + parseFloat(workerScores[c]), 0);
				totalShares = Object.keys(workerShares || {}).reduce((p, c) => p + parseInt(workerShares[c]), 0);
			}

			// candidate member layout is what blockUnlocker.js parses:
			// rewardType:login:hash:time:difficulty:shares:score
			// difficulty = BLOCK_SCALE so that effort = shares / difficulty is a real ratio
			redisClient.zadd(coin + ':blocks:candidates', height, [
				rewardType,
				login,
				share.hash,
				dateNowSeconds,
				BLOCK_SCALE,
				totalShares,
				totalScore
			].join(':'), function (err) {
				if (err) log('error', 'shares', 'Failed inserting block candidate %s \n %j', [share.hash, err]);
				callback(err);
			});
			return;
		}
		callback(null);
	});
};
