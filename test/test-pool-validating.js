// Integration test of the validating pool (poolServer.validateShares): mock node (real Epic RandomX verification) + pool + a miner that hashes for real.
// Needs hasher/epichash and a throwaway redis as in test/config.validating.json (it is flushed!). Run: node test/test-pool-validating.js
const {spawn} = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.validating.json'), 'utf8'));
const HASHER = path.join(__dirname, '..', 'hasher', 'epichash');
const ADDR = 'esYZFXHGrnEW2dumhGWYnsBarQBE7p8qMvoCdW4Q3KPkxK2sf8BV@epicbox.epiccash.com';
const TWO_256_1 = (1n << 256n) - 1n;
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = []; const cleanup = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', cleanup);

// the miner's hasher (fast mode: shares of difficulty 40 need a few dozen hashes)
const mh = spawn(HASHER, ['--raw', '--threads', '2'], {stdio: ['pipe', 'pipe', 'inherit']}); procs.push(mh);
mh.stdout.setEncoding('utf8');
let mbuf = '', mwait = {}, mkey = null, mid = 0;
mh.stdout.on('data', d => { mbuf += d; let i; while ((i = mbuf.indexOf('\n')) !== -1) { const p = mbuf.slice(0, i).split(' '); mbuf = mbuf.slice(i + 1); if (p[0] === 'K' && mkey) mkey(); else if (p[0] === 'H' && mwait[p[1]]) { mwait[p[1]](p[2]); delete mwait[p[1]]; } } });
const setKey = hex => new Promise(res => { mkey = res; mh.stdin.write('K ' + hex + '\n'); });
const hashOf = hex => new Promise(res => { const id = 'c' + (++mid); mwait[id] = res; mh.stdin.write('H ' + id + ' ' + hex + '\n'); });

function client () {
	const sock = net.connect(cfg.poolServer.ports[0].port, '127.0.0.1');
	sock.on('error', () => {});                            // the pool may not listen yet
	sock.setEncoding('utf8');
	let buf = ''; const waiting = {}; const jobs = []; const all = [];
	sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); all.push(m); if (m.method === 'job') jobs.push(m.params); if (m.id !== 'Stratum' && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } });
	let n = 0;
	const call = (method, params, rawLine) => new Promise(res => { const id = 'r' + (++n); waiting[id] = res; setTimeout(() => { if (waiting[id]) { delete waiting[id]; res({timeout: true}); } }, 8000); sock.write(rawLine ? rawLine.replace('__ID__', id) + '\n' : JSON.stringify({id, jsonrpc: '2.0', method, params}) + '\n'); });
	return {sock, jobs, all, call, closed: new Promise(r => sock.on('close', r))};
}

const bytesOf = hex => Array.from(Buffer.from(hex, 'hex'));
const diffOf = hex => { const H = BigInt('0x' + hex); return H === 0n ? TWO_256_1 : TWO_256_1 / H; };
const submitLine = (job, nonce, hashHex, tag) => '{"id":"__ID__","jsonrpc":"2.0","method":"submit","params":{"height":' + job.height + ',"job_id":' + job.job_id + ',"nonce":' + nonce.toString() + ',"pow":{"' + (tag || 'RandomX') + '":[' + bytesOf(hashHex || '00'.repeat(32)).join(',') + ']}}}';
const seedHex = job => Buffer.from(job.epochs[0][2]).toString('hex');

// look for a nonce whose hash has at least `minDiff` and (optionally) below `maxDiff`
async function findNonce (job, minDiff, maxDiff, start) {
	let nonce = start;
	const pp = Buffer.from(job.pre_pow, 'hex');
	for (let tries = 0; tries < 20000; tries++, nonce++) {
		const nb = Buffer.alloc(8); nb.writeBigUInt64BE(nonce);
		const hex = await hashOf(Buffer.concat([pp, nb]).toString('hex'));
		const d = diffOf(hex);
		if (d >= BigInt(minDiff) && (maxDiff === undefined || d < BigInt(maxDiff))) return {nonce, hash: hex, diff: d};
	}
	throw new Error('no nonce found');
}

(async () => {
	const R = redis.createClient(cfg.redis.port, cfg.redis.host, {auth_pass: cfg.redis.auth, db: cfg.redis.db || 0});
	const rc = (cmd, ...a) => new Promise((res, rej) => R[cmd](...a, (e, v) => e ? rej(e) : res(v)));
	await rc('flushdb');

	const mock = spawn('node', [path.join(__dirname, 'mock-node-rx.js'), String(cfg.node.port), '300'], {stdio: 'inherit'}); procs.push(mock);
	await sleep(1500);
	const pool = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + path.join(__dirname, 'config.validating.json'), '-module=pool'], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']}); procs.push(pool);
	let poolLog = ''; pool.stdout.on('data', d => poolLog += d); pool.stderr.on('data', d => poolLog += d);

	// 1. login and the job with the pool's own share difficulty
	let c = client(); let login, job;
	for (let i = 0; i < 60; i++) {                       // the pool needs the node job and its hasher (dataset, ~10 s)
		await sleep(1000);
		if (i > 0) { c.sock.destroy(); c = client(); }
		await sleep(200);
		login = await c.call('login', {login: 'prop:' + ADDR + '+rig1', pass: 'x', agent: 'test'});
		if (!login.result) continue;
		const t = await c.call('getjobtemplate');
		if (t.result) { job = t.result; break; }
	}
	check('login ok', login && login.result === 'ok');
	check('the miner gets the job with the pool\'s share difficulty (40), not the node\'s (4000)', job && job.difficulty.find(p => p[0] === 'randomx')[1] === 40, JSON.stringify(job && job.difficulty));
	check('other algorithms keep the node\'s difficulties', job && job.difficulty.find(p => p[0] === 'progpow')[1] === 200000);
	check('the job carries the node\'s pre_pow, height and block difficulty', job && job.height === 3717100 && job.block_difficulty.find(p => p[0] === 'randomx')[1] === 300 && job.pre_pow.length === 240);
	await setKey(seedHex(job));

	// 2. bad shares
	let r = await c.call('submit', null, submitLine(job, 5n, '00'.repeat(32)));
	check('a wrong hash is rejected (Failed to validate)', r.error && r.error.code === -32502, r.error && r.error.message);
	const easy = await findNonce(job, 40, 300, 1000n);
	r = await c.call('submit', null, submitLine(job, easy.nonce, easy.hash));
	check('a valid share is accepted at once', r.result === 'ok', JSON.stringify(r.error || r.result));
	r = await c.call('submit', null, submitLine(job, easy.nonce, easy.hash));
	check('the same nonce again is a duplicate', r.error && /Duplicate/.test(r.error.message));
	const low = await findNonce(job, 1, 20, 5000n);
	r = await c.call('submit', null, submitLine(job, low.nonce, low.hash));
	check('a hash below the miner\'s difficulty is rejected (low difficulty)', r.error && r.error.code === -32501, r.error && r.error.message);
	const stale = Object.assign({}, job, {job_id: 999999});
	r = await c.call('submit', null, submitLine(stale, easy.nonce + 1n, easy.hash));
	check('an unknown job id is "too late"', r.error && r.error.code === -32503);
	const st = await c.call('status');
	check('status answers with the miner\'s counters', st.result && st.result.accepted >= 1 && st.result.rejected >= 3, JSON.stringify(st.result));

	// 3. the node has seen no share so far: the pool checks them itself
	const raw = net.connect(cfg.node.port, '127.0.0.1'); raw.setEncoding('utf8');
	const stats = await new Promise(res => { raw.on('data', d => res(JSON.parse(d.split('\n')[0]).result)); raw.write('{"id":"q","jsonrpc":"2.0","method":"mock_stats"}\n'); });
	check('the node got no shares from the pool (only blocks are handed in)', stats.forwardedShares === 0 && stats.forwardedBlocks === 0, JSON.stringify(stats));

	// 4. a nonce above 2^53 arrives exactly (checked by the hash of the share)
	const big = await findNonce(job, 40, 300, 12279655318602121233n);
	r = await c.call('submit', null, submitLine(job, big.nonce, big.hash));
	check('a u64 nonce above 2^53 is read exactly', r.result === 'ok', String(big.nonce));

	// 5. a block: handed to the node, answer "blockfound", candidate in redis
	const blk = await findNonce(job, 300, undefined, 7000n);
	r = await c.call('submit', null, submitLine(job, blk.nonce, blk.hash));
	check('a block solution is answered with the node\'s "blockfound - hash"', r.result && r.result.indexOf('blockfound - ') === 0, JSON.stringify(r.result || r.error));
	await sleep(600);
	const cand = await rc('zrange', 'Epic Cash:blocks:candidates', 0, -1, 'WITHSCORES');
	const parts = (cand[0] || '').split(':');
	check('block candidate stored with the hash of the block', cand.length === 2 && cand[1] === '3717100' && /^[0-9a-f]{64}$/.test(parts[2] || ''), (cand[0] || '').slice(0, 50));
	check('the candidate has a positive score total and the round scores are kept', parseFloat(parts[6]) > 0 && parseFloat((await rc('hgetall', 'Epic Cash:scores:prop:round3717100'))[ADDR] || 0) > 0, 'score ' + parts[6]);
	for (let i = 0; i < 30 && !c.jobs.some(j => j.height === 3717101); i++) await sleep(200);
	check('after the block the miner gets the job of the next height', c.jobs.some(j => j.height === 3717101));
	const job2 = c.jobs.find(j => j.height === 3717101);
	r = await c.call('submit', null, submitLine(job, easy.nonce + 50n, easy.hash));
	check('a share for the old height is "too late"', r.error && r.error.code === -32503);

	// 6. shares are recorded per miner
	const w = await rc('hgetall', 'Epic Cash:unique_workers:' + ADDR + '~rig1');
	check('worker stats recorded (hashes = 40 per share)', parseInt(w.hashes) >= 80, JSON.stringify(w));

	// 7. variable difficulty: shares come much faster than one per 8 s, the pool raises the difficulty and pushes a new job
	const before = c.jobs.length;
	let nonce = 100000n;
	for (let k = 0; k < 6; k++) {
		const f = await findNonce(job2, 40, 300, nonce); nonce = f.nonce + 1n;
		await c.call('submit', null, submitLine(job2, f.nonce, f.hash));
		await sleep(400);
	}
	await sleep(2500);
	const f2 = await findNonce(job2, 40, 300, nonce); await c.call('submit', null, submitLine(job2, f2.nonce, f2.hash));
	await sleep(600);
	const last = c.jobs[c.jobs.length - 1];
	const newDiff = last.difficulty.find(p => p[0] === 'randomx')[1];
	check('the difficulty of a fast miner is raised and a new job is pushed', c.jobs.length > before && newDiff > 40, 'randomx difficulty ' + newDiff);
	check('the raised difficulty is capped by the block difficulty', newDiff <= 300, String(newDiff));

	// 8. a ProgPow share is relayed to the node and credited at the node's difficulty
	const bef = parseInt((await rc('hget', 'Epic Cash:workers:' + ADDR, 'hashes')) || 0);
	r = await c.call('submit', null, submitLine(job2, 42n, '00'.repeat(32), 'ProgPow').replace(/"job_id":\d+/, '"job_id":' + job2.job_id));
	check('a ProgPow share is relayed to the node and answered ok', r.result === 'ok', JSON.stringify(r.error || r.result));
	await sleep(500);
	const aft = parseInt((await rc('hget', 'Epic Cash:workers:' + ADDR, 'hashes')) || 0);
	check('and credited at the node\'s minimum difficulty (200000)', aft - bef === 200000, 'hashes +' + (aft - bef));

	cleanup();
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED\n' + poolLog.slice(-1800) : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(2); });
