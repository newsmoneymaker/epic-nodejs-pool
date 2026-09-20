// Имитация stratum-сервера ноды Epic (servers/src/mining/stratumserver.rs): строки JSON-RPC 2.0.
// Правила ответа на submit зависят от nonce, чтобы тест мог вызвать любой исход:
//   nonce 999 -> "blockfound - <hash>", 13 -> ошибка low difficulty (-32501),
//   14 -> ошибка stale (-32503), 15 -> ошибка validate (-32502), иначе "ok".
const net = require('net');
const PORT = parseInt(process.argv[2] || '13416');
const HEIGHT = 3717100;

const job = () => ({
	height: HEIGHT,
	job_id: 0,
	difficulty: [['cuckoo', 3], ['randomx', 4000], ['progpow', 200000]],
	block_difficulty: [['cuckoo', 1000000], ['randomx', 4000000], ['progpow', 400000000]],
	pre_pow: 'aabbcc',
	epochs: [[0, 2048, new Array(32).fill(1)]],
	algorithm: 'randomx'
});

const reply = (id, method, result, error) =>
	JSON.stringify({id, jsonrpc: '2.0', method, result: error ? null : result, error: error || null}) + '\n';

net.createServer(sock => {
	sock.setEncoding('utf8');
	let buf = '';
	sock.on('data', d => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			if (!line) continue;
			const m = JSON.parse(line);
			console.log('[node] <-', m.method, JSON.stringify(m.params || {}).slice(0, 90));
			if (m.method === 'login') {
				sock.write(reply(m.id, 'login', 'ok'));
				sock.write(JSON.stringify({id: 'Stratum', jsonrpc: '2.0', method: 'job', params: job()}) + '\n');
				// the real node sometimes pushes a "not ready" job with all difficulties 0 right after a new block
				const zero = [['cuckoo', 0], ['randomx', 0], ['progpow', 0]];
				sock.write(JSON.stringify({id: 'Stratum', jsonrpc: '2.0', method: 'job', params: Object.assign(job(), {job_id: 9, difficulty: zero, block_difficulty: zero})}) + '\n');
				sock.write(JSON.stringify({id: 'Stratum', jsonrpc: '2.0', method: 'job', params: Object.assign(job(), {job_id: 5})}) + '\n');
			} else if (m.method === 'getjobtemplate') {
				sock.write(reply(m.id, 'getjobtemplate', job()));
			} else if (m.method === 'keepalive') {
				sock.write(reply(m.id, 'keepalive', 'ok'));
			} else if (m.method === 'submit' && /"nonce":(\d{17,})/.test(line)) {
				// u64 nonce above 2^53: the digits must arrive exactly as sent (a JS Number would round them)
				const digits = /"nonce":(\d{17,})/.exec(line)[1];
				if (digits === '12279655318602121233') sock.write(reply(m.id, 'submit', 'ok'));
				else sock.write(reply(m.id, 'submit', null, {code: -32502, message: 'nonce corrupted in transit: ' + digits}));
			} else if (m.method === 'submit') {
				const n = m.params.nonce;
				if (n === 999) sock.write(reply(m.id, 'submit', 'blockfound - ' + 'ab'.repeat(32)));
				else if (n === 13) sock.write(reply(m.id, 'submit', null, {code: -32501, message: 'Share rejected due to low difficulty'}));
				else if (n === 14) sock.write(reply(m.id, 'submit', null, {code: -32503, message: 'Solution Submitted too late'}));
				else if (n === 15) sock.write(reply(m.id, 'submit', null, {code: -32502, message: 'Failed to validate solution'}));
				else sock.write(reply(m.id, 'submit', 'ok'));
			} else {
				sock.write(reply(m.id, m.method, null, {code: -32601, message: 'Method not found'}));
			}
		}
	});
	sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log('[node] mock stratum on', PORT));
