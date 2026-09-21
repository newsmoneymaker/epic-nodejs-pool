/**
 * Epic Cash Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Stratum proxy. Miners speak Epic's stratum (newline-delimited JSON-RPC) to this
 * process; every miner connection is relayed 1:1 to the node's own stratum server,
 * which builds jobs, validates PoW and submits full solutions to the network.
 *
 * The proxy adds what the node does not have:
 *   - miner identity: `login` must be the epicbox address of the miner's wallet
 *     (optionally `prop:`/`solo:` prefix and `+workername` suffix);
 *   - share accounting in redis (see shares.js), block candidates for the unlocker;
 *   - per-IP banning of miners that send many invalid shares.
 *
 * The node answers `submit` with "ok" or "blockfound - <hash>" and does not report
 * the share difficulty, so a share is credited at the node's minimum share
 * difficulty for its algorithm (taken from the job template the miner was given).
 **/

// Load required modules
let net = require('net');
let tls = require('tls');
let fs = require('fs');

let utils = require('./utils.js');
let shares = require('./shares.js');

let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let poolConfig = config.poolServer;
let nodeConfig = config.node || {host: '127.0.0.1', port: 3416};

let banningEnabled = poolConfig.banning && poolConfig.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

const MAX_CLIENT_LINE = 64 * 1024;
const MAX_UPSTREAM_LINE = 4 * 1024 * 1024;
const MAX_PENDING_SUBMITS = 1000;
const UPSTREAM_LINGER = 30 * 1000;   // how long the node connection of a vanished miner is kept for the answers of its last shares
const MAX_WORKERNAME = 32;

// Stratum error codes used by the node (servers/src/mining/stratumserver.rs)
const ERR_STALE = -32503;
const ERR_LOW_DIFFICULTY = -32501;

// Job template algorithm names (PoWType::to_str) keyed by the tag of the submitted proof
const PROOF_ALGO = {Cuckoo: 'cuckoo', RandomX: 'randomx', ProgPow: 'progpow'};

/**
 * Split a byte stream into lines
 **/
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
 * A job is usable when it is for a real block and every difficulty in it is positive.
 * The node's stratum server sends placeholder jobs (height 0, or all difficulties 0) while it has not built a template yet.
 **/
function jobIsUsable (job) {
	if (!job || typeof job.height !== 'number' || job.height <= 0) return false;
	let difficulty = pairsToMap(job.difficulty);
	let blockDifficulty = pairsToMap(job.block_difficulty);
	let names = Object.keys(difficulty);
	if (!names.length) return false;
	return names.every(function (name) {
		return difficulty[name] > 0 && blockDifficulty[name] > 0;
	});
}

/**
 * Parse the stratum login: [prop:|solo:]<epicbox address>[.note|#note][+workername]
 * Returns {address, workerName, rewardType} or {error}
 **/
// Domains of exchange deposit addresses: the deposit note is mandatory there (poolServer.requireNoteDomains)
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

	// account = epicbox address + optional deposit note (exchanges tell their customers apart by it), see utils.parseMinerAccount
	let account = utils.parseMinerAccount(rest);
	if (!account) return {error: 'Invalid epicbox address (expected <52 chars>[@domain][.note], default port only)'};

	// An exchange gives everybody the same address; a payout without the customer's note ends up nowhere
	if (!account.note && requireNoteDomains.indexOf(account.domain) !== -1) {
		return {error: 'This is an exchange address: add your deposit note, e.g. ADDRESS.123456 (digits) or ADDRESS#note'};
	}

	return {address: account.account, note: account.note, workerName: workerName, rewardType: rewardData.rewardType};
}

/**
 * Banning
 **/
/**
 * Optional allow list (poolServer.allowIPs). When it is not empty, only these addresses may connect.
 * Used while the pool is being tested and payments are not ready yet.
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

/**
 * Publish what the node tells in job templates (block difficulty per algorithm,
 * algorithm of the block being mined) for the API. Throttled: the node re-sends
 * the job every few seconds to every miner.
 **/
let lastNetwork = {height: null, algorithm: null, time: 0};

function publishNetwork (job) {
	let now = Date.now();
	if (lastNetwork.height === job.height && lastNetwork.algorithm === job.algorithm && now - lastNetwork.time < 30000) return;
	lastNetwork = {height: job.height, algorithm: job.algorithm, time: now};

	redisClient.hmset(config.coin + ':network', {
		height: job.height,
		algorithm: job.algorithm,
		difficulties: JSON.stringify(pairsToMap(job.block_difficulty)),
		updated: now
	}, function (err) {
		if (err) log('error', logSystem, 'Failed to publish network data: %j', [err]);
	});
}

/**
 * Limits against connection floods (every connection opens a connection to the node's stratum right away):
 * per IP: total connections and connections that did not log in yet; a login has to come within loginTimeout;
 * in total: maxConnections. Settings in poolServer: maxConnectionsPerIp, maxUnauthenticatedPerIp, loginTimeout (s), maxConnections.
 **/
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
 * One miner connection <-> one node stratum connection
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
		// one line per address and minute, an attack must not flood the log
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

	let upstream = net.connect(nodeConfig.port, nodeConfig.host);
	upstream.setEncoding('utf8');
	upstream.setNoDelay(true);

	let closed = false;
	let connectedAt = Date.now();
	let miner = {
		ip: ip,
		address: null,
		workerName: null,
		rewardType: 'prop',
		jobs: {},
		jobHeight: null,
		lastJobId: null,
		pending: new Map(),
		destroy: function () {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			counter.total--;
			if (!authenticated) counter.unauth--;
			totalConnections--;
			if (counter.total <= 0) delete connectionsByIp[ip];
			// diagnostics: say who closed the connection (the caller from the stack) and how long it lived
			let caller = (new Error().stack.split('\n')[2] || '').trim();
			log('info', logSystem, 'Closing connection of %s@%s after %ds, closed by: %s', [miner.address, ip, Math.round((Date.now() - connectedAt) / 1000), caller]);
			socket.destroy();
			// Shares that were sent to the node shortly before the miner's connection died are still being validated by the node (it is slow:
			// about half a second per share, so a busy node answers seconds later). Keep the node connection until the answers are in (at
			// most UPSTREAM_LINGER ms) so that these shares are credited: the node counted them, the pool must too.
			if (miner.pending.size > 0 && !upstream.destroyed) {
				miner.lingerTimer = setTimeout(function () { upstream.destroy(); }, UPSTREAM_LINGER);
				return;
			}
			upstream.destroy();
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

	function sendToMiner (obj) {
		if (!closed && socket.writable) socket.write(JSON.stringify(obj) + '\n');
	}

	function rpcError (id, method, code, message) {
		return {id: id, jsonrpc: '2.0', method: method, result: null, error: {code: code, message: message}};
	}

	/** client -> node **/
	function onClientLine (line) {
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
			case 'submit':
				return onSubmit(msg, line);
			default:
				// getjobtemplate, keepalive, status: relayed untouched
				upstream.write(line + '\n');
		}
	}

	function onLogin (msg) {
		let parsed = parseLogin(msg.params && msg.params.login);
		if (parsed.error) {
			log('warn', logSystem, 'Rejected login from %s: %s', [ip, parsed.error]);
			sendToMiner(rpcError(msg.id, 'login', -32500, parsed.error));
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

		// The node keeps the login for its own logs ("submitted by ..."), so give it the canonical one
		msg.params.login = parsed.address + (parsed.workerName ? '+' + parsed.workerName : '');
		upstream.write(JSON.stringify(msg) + '\n');

		log('info', logSystem, 'Miner logged in: %s worker=%s type=%s ip=%s', [parsed.address, parsed.workerName, parsed.rewardType, ip]);
	}

	function onSubmit (msg, rawLine) {
		if (!miner.address) {
			return sendToMiner(rpcError(msg.id, 'submit', -32500, 'Login required'));
		}

		let params = msg.params || {};
		let proofTag = params.pow && typeof params.pow === 'object' ? Object.keys(params.pow)[0] : null;

		if (miner.pending.size >= MAX_PENDING_SUBMITS) {
			// the node stopped answering: drop the oldest entry instead of leaking memory
			miner.pending.delete(miner.pending.keys().next().value);
		}
		miner.pending.set(String(msg.id), {
			height: params.height,
			jobId: params.job_id,
			algo: PROOF_ALGO[proofTag] || null
		});

		// Relay the original line. Re-serializing the parsed message would round the nonce: it is a u64 and
		// JSON.parse turns numbers above 2^53 into inexact doubles, the node would then reject the share.
		upstream.write(rawLine + '\n');
	}

	/** node -> client **/
	function onUpstreamLine (line) {
		let msg = null;
		try {
			msg = JSON.parse(line);
		} catch (e) {}

		if (msg && typeof msg === 'object') {
			if (msg.method === 'job' && msg.params) {
				// Right after a new block the node sometimes pushes a job whose difficulties are all 0 (not ready).
					// Miners cannot use it and some of them disconnect: keep it away from them, the next job is valid.
					if (!jobIsUsable(msg.params)) {
						log('info', logSystem, 'Skipped a not-ready job from the node (height %s, difficulties %j) for %s',
							[msg.params.height, msg.params.difficulty, miner.address]);
						return;
					}
					cacheJob(msg.params);
			} else if (msg.method === 'getjobtemplate' && msg.result && msg.result.pre_pow) {
				if (jobIsUsable(msg.result)) cacheJob(msg.result);
			} else if (msg.method === 'submit') {
				onSubmitReply(msg);
			}
		}

		if (!closed && socket.writable) socket.write(line + '\n');
	}

	function cacheJob (job) {
		if (typeof job.job_id !== 'number' || typeof job.height !== 'number') return;
		if (miner.jobHeight !== job.height) {
			miner.jobs = {};
			miner.jobHeight = job.height;
		}
		miner.jobs[job.job_id] = {
			height: job.height,
			algorithm: job.algorithm,
			difficulty: pairsToMap(job.difficulty),
			blockDifficulty: pairsToMap(job.block_difficulty)
		};
		miner.lastJobId = job.job_id;
		publishNetwork(job);
	}

	function onSubmitReply (msg) {
		let key = String(msg.id);
		let submit = miner.pending.get(key);
		if (!submit) return;
		miner.pending.delete(key);
		if (closed && miner.pending.size === 0) {
			// the miner is gone and this was the last answer we waited for
			clearTimeout(miner.lingerTimer);
			upstream.destroy();
		}

		if (msg.error) {
			let code = msg.error.code;
			log('info', logSystem, 'Rejected share from %s@%s: %s (%s)', [miner.address, ip, msg.error.message, code]);
			if (code !== ERR_STALE) checkBan(miner, false);
			return;
		}

		let result = typeof msg.result === 'string' ? msg.result : '';
		let blockCandidate = result.indexOf('blockfound') === 0;
		if (result !== 'ok' && !blockCandidate) return;

		let job = miner.jobs[submit.jobId] || miner.jobs[miner.lastJobId];
		let algo = submit.algo || (job && job.algorithm);
		let minDifficulty = job && job.difficulty[algo];
		let blockDifficulty = job && job.blockDifficulty[algo];
		let weight = shares.shareWeight(minDifficulty, blockDifficulty);

		if (!weight) {
			log('error', logSystem, 'Cannot weight share from %s (algo=%s job=%j): share not credited', [miner.address, algo, submit.jobId]);
			return;
		}

		checkBan(miner, true);

		let hash = blockCandidate ? (result.split(' - ')[1] || '').trim() : null;
		if (blockCandidate) {
			log('info', logSystem, 'BLOCK FOUND at height %d by %s (%s), hash %s', [submit.height, miner.address, algo, hash]);
		}

		shares.record({
			login: miner.address,
			workerName: miner.workerName,
			ip: ip,
			rewardType: miner.rewardType,
			algo: algo,
			height: submit.height,
			rawDifficulty: minDifficulty,
			weight: weight,
			blockCandidate: blockCandidate,
			hash: hash
		});
	}

	socket.on('data', lineSplitter(MAX_CLIENT_LINE, onClientLine, function () {
		log('warn', logSystem, 'Oversized line from %s@%s', [miner.address, ip]);
		miner.destroy();
	}));
	upstream.on('data', lineSplitter(MAX_UPSTREAM_LINE, onUpstreamLine, function () {
		log('error', logSystem, 'Oversized line from node stratum');
		miner.destroy();
	}));

	socket.on('error', function (err) {
		if (err.code !== 'ECONNRESET') log('warn', logSystem, 'Socket error from %s@%s: %s', [miner.address, ip, err]);
	});
	upstream.on('error', function (err) {
		log('error', logSystem, 'Node stratum %s:%d error: %s', [nodeConfig.host, nodeConfig.port, err.code || err]);
	});

	socket.on('close', function () {
		if (!closed) log('info', logSystem, 'Miner disconnected %s@%s', [miner.address, ip]);
		miner.destroy();
	});
	upstream.on('close', function () {
		miner.destroy();
	});
}

/**
 * Start listening
 **/
shares.init();

poolConfig.ports.forEach(function (portData) {
	let onConnection = function (socket) {
		handleConnection(socket, portData);
	};

	let server;
	if (portData.tls) {
		// Stratum over TLS (poolServer.sslCert = certificate chain, poolServer.sslKey = private key, PEM files).
		// The certificate is read at start: after renewing it, restart the pool service.
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
		log('info', logSystem, 'Started %sserver listening on port %d (%s), node stratum at %s:%d', [portData.tls ? 'TLS ' : '', portData.port, portData.desc || '', nodeConfig.host, nodeConfig.port]);
	});
});
