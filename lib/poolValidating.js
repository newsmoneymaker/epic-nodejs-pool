/**
 * Epic Cash Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Stratum server that checks the shares itself (poolServer.validateShares = true).
 *
 * The Epic node validates every share it gets (RandomX in "light" mode, about half a second each) and has ONE minimum share difficulty per
 * algorithm, so a proxy in front of it (pool.js) can not give a miner a difficulty of its own and the node is the bottleneck. Here the pool
 *   - keeps one connection to the node stratum only to get the block templates ("jobs") and to hand in real blocks;
 *   - gives every miner the job with a share difficulty of its own (variable difficulty, like most pools);
 *   - recomputes the RandomX hash of every RandomX share with a helper (hasher/epichash, the RandomX of the Epic node), credits the share
 *     and answers at once; a share that reaches the block difficulty is handed to the node, which answers "blockfound - <hash>";
 *   - relays ProgPow and Cuckoo shares to the node as before (they can not be checked here), credited at the node's minimum difficulty.
 * Messages are the ones of the node's stratum (newline separated JSON-RPC 2.0): login, getjobtemplate, keepalive, status, submit and the
 * pushed "job".
 *
 * RandomX input: pre_pow (bytes of the job) followed by the nonce as an 8 byte big-endian number; key: epochs[0] seed of the job;
 * difficulty of a hash = (2^256 - 1) / hash (hash as a big-endian 256 bit number).
 **/

let net = require('net');
let tls = require('tls');
let fs = require('fs');
let crypto = require('crypto');

let utils = require('./utils.js');
let shares = require('./shares.js');
let hasher = require('./hasher.js');

let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let poolConfig = config.poolServer;
let nodeConfig = config.node || {host: '127.0.0.1', port: 3416};
let varDiffConfig = Object.assign({startDiff: 20000, minDiff: 2000, maxDiff: 50000000, targetTime: 20, retargetTime: 60, variancePercent: 30, maxJump: 100}, poolConfig.varDiff || {});

let banningEnabled = poolConfig.banning && poolConfig.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

const MAX_CLIENT_LINE = 64 * 1024;
const MAX_UPSTREAM_LINE = 4 * 1024 * 1024;
const MAX_WORKERNAME = 32;
const MAX_PENDING_RELAY = 1000;
const TWO_256_1 = (1n << 256n) - 1n;

// Stratum error codes of the node (servers/src/mining/stratumserver.rs)
const ERR_STALE = -32503;
const ERR_LOW_DIFFICULTY = -32501;
const ERR_VALIDATE = -32502;

const PROOF_ALGO = {Cuckoo: 'cuckoo', RandomX: 'randomx', ProgPow: 'progpow'};

function lineSplitter (maxLength, onLine, onOverflow) {
	let buffer = '';
	return function (data) {
		buffer += data;
		let idx;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			let line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (line.length) onLine(line);
		}
		if (buffer.length > maxLength) {
			buffer = '';
			onOverflow();
		}
	};
}

function pairsToMap (pairs) {
	let map = {};
	if (Array.isArray(pairs)) {
		pairs.forEach(function (pair) {
			if (Array.isArray(pair) && typeof pair[0] === 'string') map[pair[0]] = pair[1];
		});
	}
	return map;
}

/**
 * A job is usable when it is for a real block and every difficulty in it is positive (the node sends placeholder jobs
 * with height 0 or all difficulties 0 while it has no template).
 **/
function jobIsUsable (job) {
	if (!job || typeof job.height !== 'number' || job.height <= 0) return false;
	if (typeof job.pre_pow !== 'string' || !/^[0-9a-f]+$/i.test(job.pre_pow) || job.pre_pow.length % 2) return false;
	let difficulty = pairsToMap(job.difficulty);
	let blockDifficulty = pairsToMap(job.block_difficulty);
	let names = Object.keys(difficulty);
	if (!names.length) return false;
	return names.every(function (name) {
		return difficulty[name] > 0 && blockDifficulty[name] > 0;
	});
}

/**
 * Login: [prop:|solo:]<epicbox address>[.note|#note][+workername]
 **/
let requireNoteDomains = (poolConfig.requireNoteDomains || []).map(function (d) { return String(d).toLowerCase(); });

function parseLogin (login) {
	if (typeof login !== 'string' || !login.length || login.length > 300) return {error: 'Invalid login'};

	let rewardData = utils.determineRewardData(login);
	let rest = rewardData.address;
	let workerName = null;

	let plus = rest.indexOf('+');
	if (plus !== -1) {
		workerName = utils.cleanupSpecialChars(rest.substr(plus + 1)).substr(0, MAX_WORKERNAME) || null;
		rest = rest.substr(0, plus);
	}

	let account = utils.parseMinerAccount(rest);
	if (!account) return {error: 'Invalid epicbox address (expected <52 chars>[@domain][.note], default port only)'};

	if (!account.note && requireNoteDomains.indexOf(account.domain) !== -1) {
		return {error: 'This is an exchange address: add your deposit note, e.g. ADDRESS.123456 (digits) or ADDRESS#note'};
	}

	return {address: account.account, note: account.note, workerName: workerName, rewardType: rewardData.rewardType};
}

/**
 * Banning and connection limits
 **/
let allowIPs = (poolConfig.allowIPs || []).map(String);

function isAllowedIp (ip) {
	if (!allowIPs.length) return true;
	let plain = ip.replace(/^::ffff:/, '');
	return allowIPs.indexOf(plain) !== -1 || allowIPs.indexOf(ip) !== -1;
}

function IsBannedIp (ip) {
	if (!banningEnabled || !bannedIPs[ip]) return false;
	let timeLeft = poolConfig.banning.time * 1000 - (Date.now() - bannedIPs[ip]);
	if (timeLeft > 0) return true;
	delete bannedIPs[ip];
	log('info', logSystem, 'Ban dropped for %s', [ip]);
	return false;
}

function checkBan (miner, validShare) {
	if (!banningEnabled) return;

	let stats = perIPStats[miner.ip];
	if (!stats) stats = perIPStats[miner.ip] = {validShares: 0, invalidShares: 0};
	if (validShare) stats.validShares++; else stats.invalidShares++;

	let total = stats.validShares + stats.invalidShares;
	if (total >= poolConfig.banning.checkThreshold) {
		let percent = stats.invalidShares / total * 100;
		if (percent >= poolConfig.banning.invalidPercent) {
			log('warn', logSystem, 'Banned %s@%s: %d%% invalid shares', [miner.address, miner.ip, Math.round(percent)]);
			bannedIPs[miner.ip] = Date.now();
			miner.destroy();
		}
		delete perIPStats[miner.ip];
	}
}

setInterval(function () {
	let now = Date.now();
	for (let ip in bannedIPs) {
		if (now - bannedIPs[ip] > poolConfig.banning.time * 1000) delete bannedIPs[ip];
	}
	perIPStats = {};
}, 60 * 1000);

let MAX_PER_IP = poolConfig.maxConnectionsPerIp || 100;
let MAX_UNAUTH_PER_IP = poolConfig.maxUnauthenticatedPerIp || 10;
let LOGIN_TIMEOUT = (poolConfig.loginTimeout || 20) * 1000;
let MAX_TOTAL = poolConfig.maxConnections || 3000;
let connectionsByIp = {};
let totalConnections = 0;
let limitLogged = {};

function limitReason (ip) {
	let c = connectionsByIp[ip];
	if (totalConnections >= MAX_TOTAL) return 'the pool is full (' + MAX_TOTAL + ' connections)';
	if (c && c.total >= MAX_PER_IP) return 'more than ' + MAX_PER_IP + ' connections from one address';
	if (c && c.unauth >= MAX_UNAUTH_PER_IP) return 'more than ' + MAX_UNAUTH_PER_IP + ' connections from one address that did not log in';
	return null;
}

/**
 * The node: one stratum connection for the jobs and for handing in blocks
 **/
let upstream = null;
let upstreamReady = false;
let upCalls = new Map();        // id of a request to the node -> callback(message)
let upSeq = 0;
let upKeepAlive = null;
let upRetry = 0;

let jobs = new Map();           // node job_id -> {node job, height, algorithm, prePow (Buffer), keyHex, difficulty {}, blockDifficulty {}}
let currentJob = null;
let currentKeyHex = null;
let keyReady = false;
let pendingKeyJob = null;       // a RandomX job waiting for the hasher to finish the new key
let poolJobCounter = 0;
let miners = new Set();

function upSend (obj) {
	if (upstream && upstream.writable) upstream.write(JSON.stringify(obj) + '\n');
}

function upCall (method, params, callback, rawLine) {
	let id = 'u' + (++upSeq);
	if (upCalls.size >= MAX_PENDING_RELAY) upCalls.delete(upCalls.keys().next().value);
	upCalls.set(id, callback);
	if (rawLine) {
		// the caller built the whole line with a placeholder for the id (nonces above 2^53 must not pass through JSON.parse)
		if (upstream && upstream.writable) upstream.write(rawLine.replace('__ID__', id) + '\n');
	} else {
		upSend({id: id, jsonrpc: '2.0', method: method, params: params});
	}
	// an unanswered request is dropped after a minute
	setTimeout(function () { upCalls.delete(id); }, 60 * 1000).unref();
	return id;
}

function connectUpstream () {
	upstreamReady = false;
	upstream = net.connect(nodeConfig.port, nodeConfig.host);
	upstream.setEncoding('utf8');
	upstream.setNoDelay(true);
	let sock = upstream;

	sock.on('connect', function () {
		upRetry = 0;
		log('info', logSystem, 'Connected to the node stratum %s:%d', [nodeConfig.host, nodeConfig.port]);
		let identity = poolConfig.nodeLogin || (config.blockUnlocker && config.blockUnlocker.poolAddress) || 'pool';
		upSend({id: 'up-login', jsonrpc: '2.0', method: 'login', params: {login: identity, pass: 'x', agent: 'epic-nodejs-pool'}});
	});
	sock.on('data', lineSplitter(MAX_UPSTREAM_LINE, onUpstreamLine, function () {
		log('error', logSystem, 'Oversized line from the node stratum');
		sock.destroy();
	}));
	sock.on('error', function (err) {
		log('error', logSystem, 'Node stratum %s:%d error: %s', [nodeConfig.host, nodeConfig.port, err.code || err]);
	});
	sock.on('close', function () {
		if (sock !== upstream) return;
		upstreamReady = false;
		clearInterval(upKeepAlive);
		// the answers we waited for will not come
		upCalls.forEach(function (cb) { try { cb(null); } catch (e) {} });
		upCalls.clear();
		let wait = Math.min(15000, 1000 * (++upRetry));
		log('warn', logSystem, 'Node stratum closed, reconnecting in %d s', [wait / 1000]);
		setTimeout(connectUpstream, wait);
	});
}

function onUpstreamLine (line) {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch (e) {
		return;
	}
	if (!msg || typeof msg !== 'object') return;

	if (msg.id === 'up-login') {
		if (msg.error) {
			log('error', logSystem, 'The node refused the login: %j', [msg.error]);
			return;
		}
		upstreamReady = true;
		upSend({id: 'up-job', jsonrpc: '2.0', method: 'getjobtemplate'});
		clearInterval(upKeepAlive);
		upKeepAlive = setInterval(function () { upSend({id: 'up-ka', jsonrpc: '2.0', method: 'keepalive'}); }, 15000);
		return;
	}
	if (msg.method === 'job' && msg.params) return onNodeJob(msg.params);
	if (msg.id === 'up-job' && msg.result && msg.result.pre_pow) return onNodeJob(msg.result);
	if (msg.id === 'up-ka') return;

	if (typeof msg.id === 'string' && upCalls.has(msg.id)) {
		let cb = upCalls.get(msg.id);
		upCalls.delete(msg.id);
		cb(msg);
	}
}

function seedOf (job) {
	// epochs: [[first block, last block, [32 seed bytes]], ...]; the miners use the first one
	let epoch = Array.isArray(job.epochs) && job.epochs[0];
	let bytes = epoch && epoch[2];
	if (!Array.isArray(bytes) || bytes.length !== 32) return null;
	return Buffer.from(bytes).toString('hex');
}

function onNodeJob (raw) {
	if (!jobIsUsable(raw)) return;

	let job = {
		raw: raw,
		id: raw.job_id,
		height: raw.height,
		algorithm: raw.algorithm,
		prePow: Buffer.from(raw.pre_pow, 'hex'),
		keyHex: seedOf(raw),
		difficulty: pairsToMap(raw.difficulty),
		blockDifficulty: pairsToMap(raw.block_difficulty),
		created: Date.now()
	};

	// RandomX needs its key: a new one (every epoch) makes the helper rebuild its dataset
	if (job.keyHex && job.keyHex !== currentKeyHex) {
		if (!pendingKeyJob) {
			log('info', logSystem, 'New RandomX key %s, initialising the hasher', [job.keyHex.substr(0, 16)]);
			currentKeyHex = job.keyHex;
			keyReady = false;
			hasher.setKey(job.keyHex, function (err) {
				if (err) {
					log('error', logSystem, 'Hasher could not set the key: %s', [err.message]);
					currentKeyHex = null;
					return;
				}
				keyReady = true;
				log('info', logSystem, 'Hasher is ready');
				if (pendingKeyJob) {
					// the job that waited for the key (or a newer key, if the epoch changed meanwhile: onNodeJob starts it again)
					let j = pendingKeyJob;
					pendingKeyJob = null;
					if (!currentJob || currentJob.height <= j.height) onNodeJob(j.raw);
				}
			});
		}
		pendingKeyJob = job;
		return;
	}
	if (!keyReady && job.keyHex) {
		pendingKeyJob = job;
		return;
	}
	acceptJob(job);
}

let lastPublished = {height: null, algorithm: null, time: 0};

function acceptJob (job) {
	jobs.set(String(job.id), job);
	let previous = currentJob;
	currentJob = job;
	jobs.forEach(function (j, id) {
		if (j.height < job.height || job.created - j.created > 10 * 60 * 1000) jobs.delete(id);
	});

	if (!previous || previous.height !== job.height) {
		log('info', logSystem, 'New block to mine: height %d, algorithm %s, block difficulty %j', [job.height, job.algorithm, job.blockDifficulty]);
	}
	publishNetwork(job);
	miners.forEach(function (miner) { miner.sendJob(); });
}

function publishNetwork (job) {
	let now = Date.now();
	if (lastPublished.height === job.height && lastPublished.algorithm === job.algorithm && now - lastPublished.time < 30000) return;
	lastPublished = {height: job.height, algorithm: job.algorithm, time: now};

	redisClient.hmset(config.coin + ':network', {
		height: job.height,
		algorithm: job.algorithm,
		difficulties: JSON.stringify(job.blockDifficulty),
		updated: now
	}, function (err) {
		if (err) log('error', logSystem, 'Failed to publish network data: %j', [err]);
	});
}

/** difficulty a hash stands for: (2^256 - 1) / hash */
function hashDifficulty (hashHex) {
	let h = BigInt('0x' + hashHex);
	return h === 0n ? TWO_256_1 : TWO_256_1 / h;
}

/**
 * Difficulty memory. A miner whose network drops long-lived connections (or a miner that renews its connection every
 * half minute) would start from the start difficulty every time and never live long enough for the variable difficulty to
 * act (it needs a minute and a few shares). The state of the variable difficulty is therefore kept per address and worker
 * for a while and handed to the next connection of the same worker.
 **/
const DIFF_MEMORY_TTL = (poolConfig.diffMemoryMinutes || 15) * 60 * 1000;
let diffMemory = new Map();      // "address~worker" -> {diff, shareTimes, lastRetarget, seen}

setInterval(function () {
	let now = Date.now();
	diffMemory.forEach(function (mem, key) {
		if (now - mem.seen > DIFF_MEMORY_TTL) diffMemory.delete(key);
	});
}, 60 * 1000);

/**
 * One miner connection
 **/
function handleConnection (socket, portData) {
	let ip = socket.remoteAddress;
	if (!ip) return socket.destroy();

	if (!isAllowedIp(ip)) {
		log('info', logSystem, 'Rejected connection from %s: not in poolServer.allowIPs', [ip]);
		return socket.destroy();
	}
	if (IsBannedIp(ip)) {
		log('info', logSystem, 'Rejected connection from banned IP %s', [ip]);
		return socket.destroy();
	}
	let limited = limitReason(ip);
	if (limited) {
		if (!limitLogged[ip] || Date.now() - limitLogged[ip] > 60000) {
			limitLogged[ip] = Date.now();
			log('warn', logSystem, 'Rejected connection from %s: %s', [ip, limited]);
		}
		return socket.destroy();
	}
	let counter = connectionsByIp[ip] || (connectionsByIp[ip] = {total: 0, unauth: 0});
	counter.total++;
	counter.unauth++;
	totalConnections++;
	let authenticated = false;

	socket.setEncoding('utf8');
	socket.setNoDelay(true);

	let closed = false;
	let connectedAt = Date.now();
	let miner = {
		id: crypto.randomBytes(8).toString('hex'),
		ip: ip,
		address: null,
		workerName: null,
		rewardType: 'prop',
		diff: Math.min(Math.max(portData.diff || varDiffConfig.startDiff, varDiffConfig.minDiff), varDiffConfig.maxDiff),
		fixedDiff: !!portData.fixedDiff,
		sent: new Map(),               // pool job id -> {job, diff, prev, nonces}
		relays: new Map(),             // relayed shares waiting for the node: id -> info
		shareTimes: [],
		lastRetarget: Date.now(),
		accepted: 0,
		rejected: 0,
		stale: 0,
		sendJob: function () { pushJob(); },
		destroy: function () {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			miners.delete(miner);
			counter.total--;
			if (!authenticated) counter.unauth--;
			totalConnections--;
			if (counter.total <= 0) delete connectionsByIp[ip];
			let caller = (new Error().stack.split('\n')[2] || '').trim();
			log('info', logSystem, 'Closing connection of %s@%s after %ds, closed by: %s', [miner.address, ip, Math.round((Date.now() - connectedAt) / 1000), caller]);
			socket.destroy();
		}
	};

	let loginTimer = setTimeout(function () {
		if (authenticated) return;
		log('info', logSystem, 'No login from %s within %ds, closing', [ip, LOGIN_TIMEOUT / 1000]);
		miner.destroy();
	}, LOGIN_TIMEOUT);

	log('info', logSystem, 'Miner connected from %s on port %d', [ip, portData.port]);

	if (poolConfig.minerTimeout) {
		socket.setTimeout(poolConfig.minerTimeout * 1000, function () {
			log('info', logSystem, 'Miner %s@%s timed out', [miner.address, ip]);
			miner.destroy();
		});
	}

	function send (obj) {
		if (!closed && socket.writable) socket.write(JSON.stringify(obj) + '\n');
	}

	function answer (id, method, result, error) {
		send({id: id, jsonrpc: '2.0', method: method, result: error ? null : result, error: error || null});
	}

	/** the job as this miner gets it: its own id and its own difficulty for RandomX */
	function buildJob (job) {
		let diff = miner.diff;
		let poolId = ++poolJobCounter;
		let before = null;
		// a change of difficulty on the same node job: still accept shares found for the previous one
		miner.sent.forEach(function (s) { if (s.job === job) before = s; });
		miner.sent.set(String(poolId), {
			job: job,
			diff: diff,
			prev: before ? {diff: before.diff} : null,
			nonces: before ? before.nonces : new Set()
		});
		if (miner.sent.size > 40) miner.sent.delete(miner.sent.keys().next().value);

		let out = Object.assign({}, job.raw, {job_id: poolId});
		out.difficulty = (job.raw.difficulty || []).map(function (pair) {
			return pair[0] === 'randomx' ? ['randomx', diff] : pair;
		});
		return out;
	}

	function pushJob () {
		if (!currentJob || !authenticated) return;
		send({id: 'Stratum', jsonrpc: '2.0', method: 'job', params: buildJob(currentJob)});
	}

	function onLine (line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			log('warn', logSystem, 'Malformed JSON from %s@%s', [miner.address, ip]);
			return miner.destroy();
		}
		if (!msg || typeof msg !== 'object') return miner.destroy();

		switch (msg.method) {
			case 'login':
				return onLogin(msg);
			case 'getjobtemplate':
				if (!authenticated) return answer(msg.id, 'getjobtemplate', null, {code: -32500, message: 'Login required'});
				if (!currentJob) return answer(msg.id, 'getjobtemplate', null, {code: -32000, message: 'The pool has no block template yet'});
				return answer(msg.id, 'getjobtemplate', buildJob(currentJob));
			case 'keepalive':
				return answer(msg.id, 'keepalive', 'ok');
			case 'status':
				return answer(msg.id, 'status', {
					id: miner.id,
					height: currentJob ? currentJob.height : 0,
					difficulty: miner.diff,
					accepted: miner.accepted,
					rejected: miner.rejected,
					stale: miner.stale
				});
			case 'submit':
				return onSubmit(msg, line);
			default:
				return answer(msg.id, msg.method, null, {code: -32601, message: 'Method not found'});
		}
	}

	function onLogin (msg) {
		let parsed = parseLogin(msg.params && msg.params.login);
		if (parsed.error) {
			log('warn', logSystem, 'Rejected login from %s: %s', [ip, parsed.error]);
			answer(msg.id, 'login', null, {code: -32500, message: parsed.error});
			return setTimeout(miner.destroy, 100);
		}

		if (!authenticated) {
			authenticated = true;
			counter.unauth--;
			clearTimeout(loginTimer);
		}
		miner.address = parsed.address;
		miner.workerName = parsed.workerName;
		miner.rewardType = parsed.rewardType;
		adoptRememberedDifficulty();
		miners.add(miner);

		answer(msg.id, 'login', 'ok');
		log('info', logSystem, 'Miner logged in: %s worker=%s type=%s ip=%s', [parsed.address, parsed.workerName, parsed.rewardType, ip]);
	}

	/** the same worker came back: continue with its difficulty and the share times of the earlier connection **/
	function adoptRememberedDifficulty () {
		if (miner.fixedDiff) return;
		let key = miner.address + '~' + (miner.workerName || '');
		let mem = diffMemory.get(key);
		if (mem && Date.now() - mem.seen <= DIFF_MEMORY_TTL) {
			miner.diff = Math.min(Math.max(mem.diff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
			miner.shareTimes = mem.shareTimes;
			miner.lastRetarget = mem.lastRetarget;
		} else {
			mem = {diff: miner.diff, shareTimes: miner.shareTimes, lastRetarget: miner.lastRetarget, seen: Date.now()};
			diffMemory.set(key, mem);
		}
		miner.memory = mem;
	}

	function remember () {
		if (!miner.memory) return;
		miner.memory.diff = miner.diff;
		miner.memory.lastRetarget = miner.lastRetarget;
		miner.memory.seen = Date.now();
	}

	function reject (msg, code, message, count) {
		miner.rejected++;
		if (code === ERR_STALE) miner.stale++;
		else if (count !== false) checkBan(miner, false);
		log('info', logSystem, 'Rejected share from %s@%s: %s (%s)', [miner.address, ip, message, code]);
		answer(msg.id, 'submit', null, {code: code, message: message});
	}

	function onSubmit (msg, rawLine) {
		if (!miner.address) return answer(msg.id, 'submit', null, {code: -32500, message: 'Login required'});

		let params = msg.params || {};
		let sent = miner.sent.get(String(params.job_id));
		if (!sent || !currentJob || sent.job.height !== currentJob.height) {
			return reject(msg, ERR_STALE, 'Solution submitted too late', false);
		}
		let job = sent.job;
		let proofTag = params.pow && typeof params.pow === 'object' ? Object.keys(params.pow)[0] : null;
		let algo = PROOF_ALGO[proofTag] || null;
		if (!algo) return reject(msg, ERR_VALIDATE, 'Failed to validate solution');

		// the nonce is a u64: read its digits from the line, JSON.parse would round it
		let digits = /"nonce"\s*:\s*(\d+)/.exec(rawLine);
		if (!digits || digits[1].length > 20) return reject(msg, ERR_VALIDATE, 'Failed to validate solution');
		let nonce = BigInt(digits[1]);
		if (nonce >= (1n << 64n)) return reject(msg, ERR_VALIDATE, 'Failed to validate solution');

		if (algo !== 'randomx') return relayShare(msg, rawLine, sent, job, algo, digits[1]);

		if (!job.keyHex || job.keyHex !== currentKeyHex || !keyReady) return reject(msg, ERR_STALE, 'Solution submitted too late', false);

		let nonceKey = nonce.toString();
		if (sent.nonces.has(nonceKey)) return reject(msg, ERR_VALIDATE, 'Duplicate share');
		sent.nonces.add(nonceKey);

		let nonceBuf = Buffer.alloc(8);
		nonceBuf.writeBigUInt64BE(nonce);
		hasher.hash(Buffer.concat([job.prePow, nonceBuf]).toString('hex'), function (err, hashHex) {
			if (err) {
				sent.nonces.delete(nonceKey);
				log('error', logSystem, 'Cannot check a share from %s: %s', [miner.address, err.message]);
				return answer(msg.id, 'submit', null, {code: ERR_VALIDATE, message: 'Try again'});
			}

			// a miner that sends a hash must send the right one (the node does not care, but a wrong one means a broken miner)
			let given = Array.isArray(params.pow.RandomX) && params.pow.RandomX.length === 32 ? Buffer.from(params.pow.RandomX).toString('hex') : null;
			if (given && given !== hashHex) return reject(msg, ERR_VALIDATE, 'Failed to validate solution');

			let achieved = hashDifficulty(hashHex);
			let credited = achieved >= BigInt(Math.round(sent.diff)) ? sent.diff : (sent.prev && achieved >= BigInt(Math.round(sent.prev.diff)) ? sent.prev.diff : 0);
			if (!credited) return reject(msg, ERR_LOW_DIFFICULTY, 'Share rejected due to low difficulty');

			let blockDifficulty = job.blockDifficulty.randomx;
			let isBlock = job.algorithm === 'randomx' && blockDifficulty > 0 && achieved >= BigInt(Math.round(blockDifficulty));

			miner.accepted++;
			checkBan(miner, true);

			if (!isBlock) {
				answer(msg.id, 'submit', 'ok');
				recordShare(job, credited, blockDifficulty, false, null);
				retarget();
				return;
			}

			// a block: the node has the last word, and its answer carries the hash of the block
			log('info', logSystem, 'Block solution at height %d from %s (worker %s), handing it in', [job.height, miner.address, miner.workerName || '-']);
			let line = '{"id":"__ID__","jsonrpc":"2.0","method":"submit","params":{"height":' + job.height + ',"job_id":' + job.id + ',"nonce":' + nonce.toString() + ',"pow":{"RandomX":[' + Array.from(Buffer.from(hashHex, 'hex')).join(',') + ']}}}';
			upCall('submit', null, function (reply) {
				let result = reply && typeof reply.result === 'string' ? reply.result : '';
				if (result.indexOf('blockfound') === 0) {
					let blockHash = (result.split(' - ')[1] || '').trim();
					log('info', logSystem, 'BLOCK FOUND at height %d by %s (worker %s), hash %s', [job.height, miner.address, miner.workerName || '-', blockHash]);
					answer(msg.id, 'submit', result);
					recordShare(job, credited, blockDifficulty, true, blockHash);
				} else if (result === 'ok') {
					answer(msg.id, 'submit', 'ok');
					recordShare(job, credited, blockDifficulty, false, null);
				} else {
					log('warn', logSystem, 'The node did not take the block solution at height %d: %j', [job.height, reply && reply.error]);
					// it is still a valid share for us
					answer(msg.id, 'submit', 'ok');
					recordShare(job, credited, blockDifficulty, false, null);
				}
			}, line);
		});
	}

	function recordShare (job, diff, blockDifficulty, blockCandidate, hash) {
		shares.record({
			login: miner.address,
			workerName: miner.workerName,
			ip: ip,
			rewardType: miner.rewardType,
			algo: 'randomx',
			height: job.height,
			rawDifficulty: diff,
			weight: shares.shareWeight(diff, blockDifficulty),
			blockCandidate: blockCandidate,
			hash: hash
		});
	}

	/** ProgPow / Cuckoo shares can not be checked here: the node does it, credited at the node's minimum difficulty */
	function relayShare (msg, rawLine, sent, job, algo, nonceDigits) {
		if (!upstreamReady) return reject(msg, ERR_STALE, 'Solution submitted too late', false);
		if (miner.relays.size >= MAX_PENDING_RELAY) miner.relays.delete(miner.relays.keys().next().value);
		// the same line to the node with the node's job id and the exact nonce digits
		let line = rawLine
			.replace(/"job_id"\s*:\s*\d+/, '"job_id":' + job.id)
			.replace(/"id"\s*:\s*("[^"]*"|\d+)/, '"id":"__ID__"');
		upCall('submit', null, function (reply) {
			if (!reply) return answer(msg.id, 'submit', null, {code: ERR_STALE, message: 'Solution submitted too late'});
			if (reply.error) {
				miner.rejected++;
				if (reply.error.code === ERR_STALE) miner.stale++;
				log('info', logSystem, 'Rejected share from %s@%s: %s (%s)', [miner.address, ip, reply.error.message, reply.error.code]);
				return answer(msg.id, 'submit', null, reply.error);
			}
			let result = typeof reply.result === 'string' ? reply.result : '';
			let blockCandidate = result.indexOf('blockfound') === 0;
			if (result !== 'ok' && !blockCandidate) return answer(msg.id, 'submit', result);
			miner.accepted++;
			let minDifficulty = job.difficulty[algo];
			let blockDifficulty = job.blockDifficulty[algo];
			let hash = blockCandidate ? (result.split(' - ')[1] || '').trim() : null;
			if (blockCandidate) log('info', logSystem, 'BLOCK FOUND at height %d by %s (%s), hash %s', [job.height, miner.address, algo, hash]);
			answer(msg.id, 'submit', result);
			if (!(minDifficulty > 0) || !(blockDifficulty > 0)) return;
			shares.record({
				login: miner.address, workerName: miner.workerName, ip: ip, rewardType: miner.rewardType, algo: algo, height: job.height,
				rawDifficulty: minDifficulty, weight: shares.shareWeight(minDifficulty, blockDifficulty), blockCandidate: blockCandidate, hash: hash
			});
		}, line);
	}

	/** variable difficulty: aim at one share per targetTime seconds */
	function retarget () {
		if (miner.fixedDiff) return;
		let now = Date.now();
		miner.shareTimes.push(now);
		if (miner.shareTimes.length > 30) miner.shareTimes.shift();
		remember();
		if (now - miner.lastRetarget < varDiffConfig.retargetTime * 1000 || miner.shareTimes.length < 4) return;
		miner.lastRetarget = now;

		let span = (miner.shareTimes[miner.shareTimes.length - 1] - miner.shareTimes[0]) / 1000 / (miner.shareTimes.length - 1);
		if (!(span > 0)) span = 0.1;
		let ratio = varDiffConfig.targetTime / span;
		if (Math.abs(1 - ratio) * 100 < varDiffConfig.variancePercent) return;
		let newDiff = miner.diff * ratio;
		let jump = varDiffConfig.maxJump / 100;
		newDiff = Math.min(Math.max(newDiff, miner.diff * (1 - jump / (1 + jump))), miner.diff * (1 + jump));
		let blockDiff = currentJob && currentJob.blockDifficulty.randomx ? currentJob.blockDifficulty.randomx : varDiffConfig.maxDiff;
		let cap = Math.min(varDiffConfig.maxDiff, blockDiff / 4);
		newDiff = Math.round(Math.min(Math.max(newDiff, varDiffConfig.minDiff), Math.max(cap, varDiffConfig.minDiff)));
		if (newDiff === miner.diff) return;
		log('info', logSystem, 'Difficulty of %s@%s: %d -> %d (a share every %ss)', [miner.address, ip, miner.diff, newDiff, span.toFixed(1)]);
		miner.diff = newDiff;
		miner.shareTimes.length = 0;          // the same array is shared with the memory of this worker
		remember();
		pushJob();
	}

	socket.on('data', lineSplitter(MAX_CLIENT_LINE, onLine, function () {
		log('warn', logSystem, 'Oversized line from %s@%s', [miner.address, ip]);
		miner.destroy();
	}));

	socket.on('error', function (err) {
		if (err.code !== 'ECONNRESET') log('warn', logSystem, 'Socket error from %s@%s: %s', [miner.address, ip, err]);
	});

	socket.on('close', function () {
		if (!closed) log('info', logSystem, 'Miner disconnected %s@%s', [miner.address, ip]);
		miner.destroy();
	});
}

/**
 * Start
 **/
shares.init();
connectUpstream();

poolConfig.ports.forEach(function (portData) {
	let onConnection = function (socket) {
		handleConnection(socket, portData);
	};

	let server;
	if (portData.tls) {
		let options;
		try {
			options = {
				cert: fs.readFileSync(poolConfig.sslCert),
				key: fs.readFileSync(poolConfig.sslKey),
				minVersion: 'TLSv1.2'
			};
		} catch (e) {
			log('error', logSystem, 'Cannot read the TLS certificate/key for port %d: %s', [portData.port, e.message]);
			return;
		}
		server = tls.createServer(options, onConnection);
		server.on('tlsClientError', function (err, socket) {
			log('info', logSystem, 'TLS handshake failed from %s: %s', [socket && socket.remoteAddress, err.message]);
		});
	} else {
		server = net.createServer(onConnection);
	}

	server.listen(portData.port, poolConfig.bindIp || '0.0.0.0', function (error) {
		if (error) {
			log('error', logSystem, 'Could not start server listening on port %d: %j', [portData.port, error]);
			return;
		}
		log('info', logSystem, 'Started %sserver listening on port %d (%s), share checking here, node stratum at %s:%d', [portData.tls ? 'TLS ' : '', portData.port, portData.desc || '', nodeConfig.host, nodeConfig.port]);
	});
});
