// Интеграционный тест: клиент -> pool (прокси) -> mock-node, с проверкой того, что легло в Redis.
// Запуск: node test/test-pool.js <pool_port> <redis_port> <redis_pass> <redis_db>
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const redis = require(path.join(__dirname, '../node_modules/redis'));

const [POOL_PORT, R_PORT, R_PASS, R_DB] = [parseInt(process.argv[2]), parseInt(process.argv[3]), process.argv[4], parseInt(process.argv[5])];

// корректный epicbox-адрес: base58check(version[1,0] + compressed secp256k1 key)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = b => { let n = BigInt('0x' + b.toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const sha = b => crypto.createHash('sha256').update(b).digest();
function newAddress () {
	const e = crypto.createECDH('secp256k1'); e.generateKeys();
	const p = Buffer.concat([Buffer.from([1, 0]), e.getPublicKey(null, 'compressed')]);
	return enc(Buffer.concat([p, sha(sha(p)).slice(0, 4)]));
}

let failed = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++; };

function client () {
	const sock = net.connect(POOL_PORT, '127.0.0.1'); sock.setEncoding('utf8');
	const c = {sock, inbox: [], waiters: [], closed: false};
	let buf = '';
	sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) { const m = JSON.parse(l); c.inbox.push(m); c.waiters.forEach(w => w()); } } });
	sock.on('close', () => { c.closed = true; c.waiters.forEach(w => w()); });
	sock.on('error', () => {});
	c.send = o => sock.write(JSON.stringify(o) + '\n');
	c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
		const t = setTimeout(() => { done = true; rej(new Error('timeout')); }, ms);
		let done = false; const check = () => { if (done) return; const i = c.inbox.findIndex(pred); if (i >= 0) { done = true; clearTimeout(t); res(c.inbox.splice(i, 1)[0]); } else if (c.closed) { done = true; clearTimeout(t); rej(new Error('closed')); } };
		c.waiters.push(check); check();
	});
	return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const r = redis.createClient(R_PORT, '127.0.0.1', {db: R_DB, auth_pass: R_PASS});
	const rc = (cmd, ...a) => new Promise((res, rej) => r[cmd](...a, (e, v) => e ? rej(e) : res(v)));
	await rc('flushdb');
	await rc('hset', 'Epic Cash:stats', 'lastBlockFound', Date.now() - 60000);

	const addr = newAddress();
	const canonical = addr + '@epicbox.epiccash.com';

	let c, m;
	// 0. защита от потока подключений без логина: не больше 10 на IP, остальные сразу закрываются; без логина закрывают через loginTimeout (3 с)
	const flood = []; for (let i = 0; i < 12; i++) flood.push(client());
	await sleep(600);
	check('из 12 подключений без логина сразу закрыты 2 лишних (лимит 10 на IP)', flood.filter(x => x.closed).length === 2, 'closed=' + flood.filter(x => x.closed).length);
	await sleep(3600);
	check('оставшиеся без логина закрыты по таймауту входа', flood.every(x => x.closed));
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: canonical + '+lim', pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('после потока нормальный логин проходит, вошедшего таймаут не трогает', m.result === 'ok');
	await sleep(3600);
	check('залогиненное соединение живёт дольше таймаута входа', !c.closed);
	c.sock.destroy();

	// 1. плохой логин отклоняется и соединение закрывается
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: 'not-an-address', pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('невалидный адрес отклонён', m.error && m.error.code === -32500, m.error && m.error.message);
	await sleep(300); check('соединение закрыто после отказа', c.closed);

	// 2. адрес с нестандартным портом отклоняется
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: addr + '@epicbox.epiccash.com:8080', pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('нестандартный порт epicbox отклонён', !!m.error);

	// 2b. метка депозита (payment ID биржи): у своего кошелька необязательна, у адреса биржи обязательна
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: canonical + '.123456+rigN', pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('своя метка .цифры принята', m.result === 'ok', JSON.stringify(m.error || ''));
	const exch = newAddress() + '@epicbox.nonkyc.io';
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: exch, pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('адрес биржи без метки отклонён', m.error && /deposit note/.test(m.error.message), m.error && m.error.message);
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: exch + '#abc-1+w', pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('адрес биржи с меткой #текст принят', m.result === 'ok', JSON.stringify(m.error || ''));
	c = client();
	c.send({id: '1', jsonrpc: '2.0', method: 'login', params: {login: canonical + '.' + '1'.repeat(33), pass: 'x', agent: 't'}});
	m = await c.wait(x => x.method === 'login');
	check('слишком длинная метка отклонена (не превращается в домен)', !!m.error);

	// 3. submit без логина
	c = client();
	c.send({id: '2', jsonrpc: '2.0', method: 'submit', params: {height: 3717100, job_id: 0, nonce: 1, pow: {RandomX: [1]}}});
	m = await c.wait(x => x.method === 'submit');
	check('submit без login отклонён', m.error && /Login/.test(m.error.message));

	// 4. нормальный логин: прокси пересылает login ноде, майнер получает job
	c = client();
	c.send({id: '3', jsonrpc: '2.0', method: 'login', params: {login: 'prop:' + addr + '+rig1', pass: 'x', agent: 'test'}});
	m = await c.wait(x => x.method === 'login');
	check('login ok', m.result === 'ok');
	const job = await c.wait(x => x.method === 'job');
	check('job дошёл до майнера без изменений', job.params.height === 3717100 && job.params.algorithm === 'randomx');
	const next = await c.wait(x => x.method === 'job');
	check('задание с нулевыми сложностями не дошло до майнера, следующее нормальное дошло', next.params.job_id === 5 && !c.inbox.some(x => x.method === 'job' && x.params.job_id === 9), 'job_id=' + next.params.job_id);

	// 5. шары: randomx x3, progpow x1, cuckoo x1, затем ошибки
	const sub = (id, nonce, tag) => { c.send({id: String(id), jsonrpc: '2.0', method: 'submit', params: {height: 3717100, job_id: 0, nonce, pow: {[tag]: [0]}}}); return c.wait(x => x.id === String(id)); };
	for (let i = 0; i < 3; i++) { m = await sub('s' + i, 100 + i, 'RandomX'); check('randomx share ' + i + ' ok', m.result === 'ok'); }
	m = await sub('sp', 200, 'ProgPow'); check('progpow share ok', m.result === 'ok');
	m = await sub('sc', 300, 'Cuckoo'); check('cuckoo share ok', m.result === 'ok');
	m = await sub('e1', 13, 'RandomX'); check('low difficulty ошибка проброшена', m.error && m.error.code === -32501);
	m = await sub('e2', 14, 'RandomX'); check('stale ошибка проброшена', m.error && m.error.code === -32503);
	await sleep(300);

	// 6. что записалось в Redis (до блока)
	const shares = await rc('hgetall', 'Epic Cash:shares_actual:prop:roundCurrent');
	const expectShares = 3 * Math.round(4000 / 4000000 * 1e9) + Math.round(200000 / 400000000 * 1e9) + Math.round(3 / 1000000 * 1e9);
	check('shares_actual = сумма нормированных весов', parseInt(shares[canonical]) === expectShares, 'got ' + shares[canonical] + ' want ' + expectShares);
	const scores = await rc('hgetall', 'Epic Cash:scores:prop:roundCurrent');
	check('slush score записан и > 0', parseFloat(scores[canonical]) > 0, JSON.stringify(scores));
	const w = await rc('hgetall', 'Epic Cash:workers:' + canonical);
	check('workers hash: lastShare есть', !!w.lastShare);
	const uw = await rc('hgetall', 'Epic Cash:unique_workers:' + canonical + '~rig1');
	check('unique_workers для rig1', !!uw.lastShare);
	const hr = await rc('zrange', 'Epic Cash:hashrate', 0, -1);
	check('hashrate zset содержит 5 записей воркера + 5 пользователя', hr.length === 10, 'len=' + hr.length);

	// 7. блок
	m = await sub('blk', 999, 'RandomX');
	check('blockfound проброшен майнеру', typeof m.result === 'string' && m.result.indexOf('blockfound') === 0);
	await sleep(400);
	const cand = await rc('zrange', 'Epic Cash:blocks:candidates', 0, -1, 'WITHSCORES');
	check('кандидат блока в zset', cand.length === 2 && cand[1] === '3717100', JSON.stringify(cand));
	if (cand.length === 2) {
		const p = cand[0].split(':');
		check('кандидат: rewardType/login/hash', p[0] === 'prop' && p[1] === canonical && p[2] === 'ab'.repeat(32), cand[0].slice(0, 60) + '…');
		check('кандидат: difficulty = BLOCK_SCALE', p[4] === '1000000000');
		check('кандидат: totalShares учитывает шару-блок', parseInt(p[5]) === expectShares + Math.round(4000 / 4000000 * 1e9), 'shares=' + p[5]);
		// очки раунда (slush) должны сохраняться под высотой блока, иначе майнеры не получат свою долю блока
		check('кандидат: сумма очков раунда > 0', parseFloat(p[6]) > 0, 'score=' + p[6]);
		const kept = await rc('hgetall', 'Epic Cash:scores:prop:round3717100');
		check('очки раунда лежат под высотой блока', !!kept && parseFloat(kept[canonical]) > 0);
		check('очков раунда нет в ключе без типа награды', (await rc('exists', 'Epic Cash:scores:roundCurrent')) === 0);
	}
	const after = await rc('exists', 'Epic Cash:shares_actual:prop:roundCurrent');
	const round = await rc('exists', 'Epic Cash:shares_actual:prop:round3717100');
	check('раунд переименован в round<height>', after === 0 && round === 1);

	// 7b. u64-nonce больше 2^53 должен дойти до ноды без искажений (прокси не должен пересобирать JSON)
	c.sock.write('{"id":"big","jsonrpc":"2.0","method":"submit","params":{"height":3717101,"job_id":0,"nonce":12279655318602121233,"pow":{"RandomX":[0]}}}\n');
	m = await c.wait(x => x.id === 'big');
	check('u64 nonce > 2^53 доходит до ноды без искажений', m.result === 'ok', JSON.stringify(m.error || m.result));

	// 8. status/keepalive проходят транзитом
	c.send({id: 'k', jsonrpc: '2.0', method: 'keepalive'});
	m = await c.wait(x => x.id === 'k'); check('keepalive транзитом', m.result === 'ok');

	r.quit();
	console.log(failed ? '\nПРОВАЛЕНО: ' + failed : '\nВСЕ ПРОВЕРКИ ПРОШЛИ');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ОШИБКА ТЕСТА:', e.message); process.exit(2); });
