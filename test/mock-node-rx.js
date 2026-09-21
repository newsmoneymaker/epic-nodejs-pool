// Mock of the Epic node stratum for the validating pool: jobs with a real RandomX key, blocks are verified with the real Epic RandomX
// (hasher/epichash), everything else is answered like the node does. The node counts what the pool forwards to it.
// node mock-node-rx.js <port> <block difficulty of randomx>
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const {spawn} = require('child_process');
const PORT = parseInt(process.argv[2] || '13416');
const BLOCK_DIFF = parseInt(process.argv[3] || '300');
const SEED = Array.from(crypto.createHash('sha256').update('epic-test-seed').digest());          // 32 bytes as the node sends them
const TWO_256_1 = (1n << 256n) - 1n;

let height = 3717100, jobId = 10, prePow = crypto.randomBytes(120).toString('hex');
const socks = new Set();
const stats = {forwardedShares: 0, forwardedBlocks: 0, other: 0};

const job = () => ({
	height, job_id: jobId,
	difficulty: [['cuckoo', 3], ['randomx', 4000], ['progpow', 200000]],
	block_difficulty: [['cuckoo', 1000000], ['randomx', BLOCK_DIFF], ['progpow', 400000000]],
	pre_pow: prePow, epochs: [[0, 2048, SEED]], algorithm: 'randomx'
});
const reply = (id, method, result, error) => JSON.stringify({id, jsonrpc: '2.0', method, result: error ? null : result, error: error || null}) + '\n';
const push = () => socks.forEach(s => { try { s.write(JSON.stringify({id: 'Stratum', jsonrpc: '2.0', method: 'job', params: job()}) + '\n'); } catch (e) {} });

// the verifier
const h = spawn(path.join(__dirname, '..', 'hasher', 'epichash'), ['--raw', '--threads', '1', '--light']);
h.stdout.setEncoding('utf8');
let hbuf = '', waiting = {}, keyOk = false, keyWait = [];
h.stdout.on('data', d => { hbuf += d; let i; while ((i = hbuf.indexOf('\n')) !== -1) { const p = hbuf.slice(0, i).split(' '); hbuf = hbuf.slice(i + 1); if (p[0] === 'K') { keyOk = true; keyWait.forEach(f => f()); keyWait = []; } else if (p[0] === 'H' && waiting[p[1]]) { waiting[p[1]](p[2]); delete waiting[p[1]]; } } });
h.stdin.write('K ' + Buffer.from(SEED).toString('hex') + '\n');
let hid = 0;
const hashOf = (hex, cb) => { const go = () => { const id = 'm' + (++hid); waiting[id] = cb; h.stdin.write('H ' + id + ' ' + hex + '\n'); }; keyOk ? go() : keyWait.push(go); };

net.createServer(sock => {
	socks.add(sock);
	sock.setEncoding('utf8');
	let buf = '';
	sock.on('data', d => {
		buf += d; let i;
		while ((i = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			if (!line) continue;
			const m = JSON.parse(line);
			if (m.method === 'login') sock.write(reply(m.id, 'login', 'ok'));                 // the real node does not push a job on login
			else if (m.method === 'getjobtemplate') sock.write(reply(m.id, 'getjobtemplate', job()));
			else if (m.method === 'keepalive') sock.write(reply(m.id, 'keepalive', 'ok'));
			else if (m.method === 'mock_stats') sock.write(reply(m.id, 'mock_stats', Object.assign({height}, stats)));
			else if (m.method === 'submit') {
				const tag = Object.keys(m.params.pow)[0];
				const digits = /"nonce"\s*:\s*(\d+)/.exec(line)[1];
				if (tag !== 'RandomX') { stats.forwardedShares++; sock.write(reply(m.id, 'submit', 'ok')); continue; }
				if (m.params.job_id !== jobId || m.params.height !== height) { sock.write(reply(m.id, 'submit', null, {code: -32503, message: 'Solution Submitted too late'})); continue; }
				const nb = Buffer.alloc(8); nb.writeBigUInt64BE(BigInt(digits));
				hashOf(Buffer.concat([Buffer.from(prePow, 'hex'), nb]).toString('hex'), hash => {
					const H = BigInt('0x' + hash), diff = H === 0n ? TWO_256_1 : TWO_256_1 / H;
					if (diff >= BigInt(BLOCK_DIFF)) {
						stats.forwardedBlocks++;
						height++; jobId++; prePow = crypto.randomBytes(120).toString('hex');
						sock.write(reply(m.id, 'submit', 'blockfound - ' + crypto.createHash('sha256').update(hash).digest('hex')));
						push();
					} else { stats.forwardedShares++; sock.write(reply(m.id, 'submit', diff >= 4000n ? 'ok' : null, diff >= 4000n ? null : {code: -32501, message: 'Share rejected due to low difficulty'})); }
				});
			} else sock.write(reply(m.id, m.method, null, {code: -32601, message: 'Method not found'}));
		}
	});
	sock.on('close', () => socks.delete(sock));
	sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log('mock epic node (RandomX verified) on', PORT, 'block difficulty', BLOCK_DIFF));
