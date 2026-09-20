// Integration test of blockUnlocker.js + paymentProcessor.js against a mock wallet (Owner API JSON-RPC), a mock node
// (/v1/chain, /v1/headers/<h>) and a real redis (db 1 of the pool's redis, flushed). Run: node test/test-payments.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const redis = require(path.join(__dirname, '../node_modules/redis'));

const APP = path.join(__dirname, '..');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));
const WALLET_PORT = 13420, NODE_PORT = 13413, SECRET = 'testsecret';
const COIN = base.coin;

let failed = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------- mock wallet
const wallet = {
	spendable: 100000000000, sendCalls: [], cancelCalls: [], txs: [], outputs: [], nextId: 0,
	autoConfirmMs: 1500
};
function walletServer () {
	const expected = 'Basic ' + Buffer.from('epic:' + SECRET).toString('base64');
	return http.createServer((req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			if (req.headers.authorization !== expected) { res.statusCode = 401; return res.end(); }
			const { method, params, id } = JSON.parse(body);
			const ok = v => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { Ok: v } }));
			const err = m => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: m } }));
			if (method === 'retrieve_summary_info') {
				return ok([true, { last_confirmed_height: '1000', amount_currently_spendable: String(wallet.spendable), amount_awaiting_confirmation: '0', amount_locked: '0', total: String(wallet.spendable) }]);
			}
			if (method === 'retrieve_outputs') {
				const list = wallet.outputs.slice(params.offset, params.offset + params.limit);
				return ok({ outputs: list, pager: { limit: params.limit, offset: params.offset, records_read: list.length, total_records: wallet.outputs.length, sort_order: 'desc' }, refresh_from_node: true });
			}
			if (method === 'retrieve_txs') {
				let txs = wallet.txs.filter(t => !params.tx_slate_id || t.tx_slate_id === params.tx_slate_id);
				txs = txs.slice().sort((a, b) => b.id - a.id);
				return ok({ txs: txs.slice(params.offset, params.offset + params.limit), pager: { total_records: txs.length }, refresh_from_node: true });
			}
			if (method === 'cancel_tx') {
				wallet.cancelCalls.push(params.tx_slate_id);
				const t = wallet.txs.find(t => t.tx_slate_id === params.tx_slate_id);
				if (t) t.tx_type = 'TxSentCancelled';                       // cancelled by the pool: no answer in time
				return ok(null);
			}
			if (method === 'init_send_tx') {
				const a = params.args;
				wallet.sendCalls.push(a);
				const dest = a.send_args.dest;
				if (dest.indexOf('failbefore') !== -1) return err('epicbox: cannot reach the relay');
				const amount = parseInt(a.amount), fee = 800000, change = 5000;
				if (dest.indexOf('notenough') !== -1) return err('{"NotEnoughFunds":{"available":0,"available_disp":"0.00000000","needed":' + (parseInt(a.amount) + 800000) + '}}');
				const tx = {
					id: wallet.nextId++, tx_slate_id: uuid(), tx_type: 'TxSentMempool', confirmed: false, fee: String(fee),
					amount_debited: String(amount + fee + change), amount_credited: String(change), public_addr: dest,
					creation_ts: new Date().toISOString(), messages: { messages: [{ id: '0', message: a.message }] }
				};
				wallet.txs.push(tx);
				if (dest.indexOf('noanswer') === -1) setTimeout(() => { if (tx.tx_type === 'TxSentMempool') { tx.tx_type = 'TxSent'; tx.confirmed = true; tx.confirmation_height = 1000; tx.kernel_excess = '09' + crypto.randomBytes(32).toString('hex'); } }, wallet.autoConfirmMs);
				if (dest.indexOf('failafter') !== -1) return err('epicbox: connection reset while waiting');   // sent, but the caller does not learn it
				return ok({ id: tx.tx_slate_id, fee: String(fee) });
			}
			err('unknown method ' + method);
		});
	});
}

// ---------------------------------------------------------------- mock node
const tip = 1000;
const nodeServer = () => http.createServer((req, res) => {
	res.setHeader('Content-Type', 'application/json');
	if (req.url === '/v1/chain') return res.end(JSON.stringify({ height: tip }));
	const m = /^\/v1\/headers\/(\d+)$/.exec(req.url);
	if (m) return res.end(JSON.stringify({ height: parseInt(m[1]), hash: 'hash' + m[1] }));
	res.statusCode = 404; res.end('{}');
});

// ---------------------------------------------------------------- helpers
function makeConfig (file, patch, unlockerPatch) {
	const c = JSON.parse(JSON.stringify(base));
	c.node = { host: '127.0.0.1', port: 13416, api: { host: '127.0.0.1', port: NODE_PORT } };
	c.wallet = { host: '127.0.0.1', port: WALLET_PORT, user: 'epic', secretFile: path.join(os.tmpdir(), 'epic-test-secret') };
	c.blockUnlocker = Object.assign({ enabled: true, interval: 1, depth: 5, poolFee: 1, soloFee: -1, devDonation: 0, networkFee: 0, finderReward: 0 }, unlockerPatch || {});
	c.payments = Object.assign({ enabled: true, dryRun: false, interval: 1, minPayment: 1000000, maxTransactionAmount: 500000000, maxPaymentsPerRound: 10,
		minConfirmations: 1, pendingTimeoutHours: 0.0008, reserve: 0, onlyAccounts: [], unknownAfterSeconds: 2 }, patch || {});
	fs.writeFileSync(file, JSON.stringify(c));
}
function run (moduleName, cfgFile, logs) {
	const p = spawn('node', ['init.js', '-config=' + cfgFile, '-module=' + moduleName], { cwd: APP });
	p.stdout.on('data', d => logs.push(String(d).replace(/\x1b\[[0-9;]*m/g, '')));
	p.stderr.on('data', d => logs.push('STDERR ' + d));
	return p;
}

(async () => {
	fs.writeFileSync(path.join(os.tmpdir(), 'epic-test-secret'), SECRET);
	const cfgMain = path.join(os.tmpdir(), 'epic-pay-main.json');
	makeConfig(cfgMain);

	const ws = walletServer().listen(WALLET_PORT, '127.0.0.1');
	const ns = nodeServer().listen(NODE_PORT, '127.0.0.1');

	const r = redis.createClient(base.redis.port, '127.0.0.1', { db: base.redis.db, auth_pass: base.redis.auth });
	const rc = (cmd, ...a) => new Promise((res, rej) => r[cmd](...a, (e, v) => e ? rej(e) : res(v)));
	await rc('flushdb');

	// ------------- data: three candidates (ours, orphan, undecidable) and one that is too young
	const A1 = 'acc-one@epicbox.epiccash.com', A2 = 'acc-two@epicbox.epiccash.com';
	const cand = (type, login, hash, shares, score) => [type, login, hash, 1789000000, 1000000000, shares, score].join(':');
	await rc('zadd', COIN + ':blocks:candidates', 100, cand('prop', A1, 'hash100', 4000, 4));   // ours: confirmed coinbase in the wallet
	await rc('zadd', COIN + ':blocks:candidates', 200, cand('prop', A1, 'someotherhash', 10, 10)); // header has another hash, no output: orphan
	await rc('zadd', COIN + ':blocks:candidates', 300, cand('prop', A1, 'hash300', 10, 10));       // hash matches but no confirmed output: wait
	await rc('zadd', COIN + ':blocks:candidates', 998, cand('prop', A1, 'hash998', 10, 10));       // too young
	await rc('hset', COIN + ':scores:prop:round100', A1, '3');
	await rc('hset', COIN + ':scores:prop:round100', A2, '1');
	await rc('hset', COIN + ':scores:prop:round200', A1, '10');
	const coinbase = (height, value, status) => ({ commit: 'c' + height + status, output: { commit: 'c', height: String(height), is_coinbase: true, lock_height: String(height + 1440), status, value: String(value) } });
	wallet.outputs = [
		coinbase(100, 1234, 'Unconfirmed'),                      // phantom output of a template that never became a block
		coinbase(100, 1000000000, 'Unspent'),                    // the real one: 10 EPIC
		coinbase(300, 555, 'Unconfirmed'),
		{ commit: 'x', output: { commit: 'x', height: '100', is_coinbase: false, lock_height: '0', status: 'Unspent', value: '777' } }
	];

	// accounts for the payment scenarios (balances set directly)
	const N1 = 'esNoteKey@epicbox.nonkyc.io#123456';                 // exchange customer: the note travels as the message
	const FB = 'acc-failbefore@epicbox.epiccash.com';                // send fails and nothing was sent: must come back
	const FA = 'acc-failafter@epicbox.epiccash.com';                 // send "fails" after the wallet did it: must NOT be paid twice
	const NA = 'acc-noanswer@epicbox.epiccash.com';                  // the miner never answers: cancelled and returned
	const NE = 'acc-notenough@epicbox.epiccash.com';                 // wallet says NotEnoughFunds (change of the previous payout not confirmed yet)
	const SMALL = 'acc-small@epicbox.epiccash.com';                  // below the minimum payment
	await rc('hset', COIN + ':workers:' + N1, 'balance', 50000000);
	await rc('hset', COIN + ':workers:' + FB, 'balance', 30000000);
	await rc('hset', COIN + ':workers:' + FA, 'balance', 40000000);
	await rc('hset', COIN + ':workers:' + NA, 'balance', 20000000);
	await rc('hset', COIN + ':workers:' + NE, 'balance', 60000000);
	await rc('hset', COIN + ':workers:' + SMALL, 'balance', 500000);

	const logsU = [], logsP = [];
	const unlocker = run('unlocker', cfgMain, logsU);
	await sleep(4500);

	console.log('--- block unlocker');
	const cands = await rc('zrange', COIN + ':blocks:candidates', 0, -1);
	const matured = await rc('zrange', COIN + ':blocks:matured', 0, -1, 'WITHSCORES');
	check('свой блок 100 ушёл из кандидатов в matured', !cands.some(c => /:hash100:/.test(c)) && matured.some(m => /:hash100:.*:0:1000000000$/.test(m)), matured.join(' | '));
	check('орфан 200 записан как orphaned=1 без награды', matured.some(m => /:someotherhash:\d+:\d+:\d+:1$/.test(m)));
	check('блок 300 (хеш совпал, выхода нет) остался кандидатом', cands.some(c => /:hash300:/.test(c)));
	check('молодой блок 998 остался кандидатом', cands.some(c => /:hash998:/.test(c)));
	check('раунды свой/орфан удалены, раунд 300 не тронут', (await rc('exists', COIN + ':scores:prop:round100')) === 0 && (await rc('exists', COIN + ':scores:prop:round200')) === 0);
	// 10 EPIC, fee 1% -> 9.9 EPIC, split 3:1
	const b1 = parseInt(await rc('hget', COIN + ':workers:' + A1, 'balance')), b2 = parseInt(await rc('hget', COIN + ':workers:' + A2, 'balance'));
	check('баланс acc-one = 3/4 от 9.9 EPIC (награда из кошелька, а не из фантомного выхода)', b1 === 742500000, String(b1));
	check('баланс acc-two = 1/4 от 9.9 EPIC', b2 === 247500000, String(b2));
	await sleep(2500);
	check('повторный проход не начисляет дважды', parseInt(await rc('hget', COIN + ':workers:' + A1, 'balance')) === 742500000);
	unlocker.kill();

	console.log('--- payment processor');
	const proc = run('payments', cfgMain, logsP);
	await sleep(20000);
	proc.kill();
	await sleep(500);

	const bal = async (a, f) => parseInt(await rc('hget', COIN + ':workers:' + a, f)) || 0;
	const sentTo = dest => wallet.sendCalls.filter(a => a.send_args.dest === dest);
	const txsTo = dest => wallet.txs.filter(t => t.public_addr === dest);

	check('acc-one выплачен полностью (лимит 5 EPIC на транзакцию -> две выплаты)', (await bal(A1, 'paid')) === 742500000 && (await bal(A1, 'balance')) === 0 && (await bal(A1, 'pending')) === 0,
		`paid=${await bal(A1, 'paid')} balance=${await bal(A1, 'balance')} pending=${await bal(A1, 'pending')} sends=${sentTo(A1).length}`);
	check('acc-one: ровно 2 транзакции 5 EPIC + 2.425 EPIC', txsTo(A1).length === 2 && sentTo(A1).map(a => parseInt(a.amount)).sort().join() === '242500000,500000000');
	check('acc-two выплачен', (await bal(A2, 'paid')) === 247500000 && (await bal(A2, 'balance')) === 0);
	const n1 = sentTo('esNoteKey@epicbox.nonkyc.io');
	check('метка ушла как message, адрес без метки', n1.length === 1 && n1[0].message === '123456' && n1[0].send_args.method === 'epicbox' && n1[0].send_args.finalize === true, JSON.stringify(n1[0] && { m: n1[0].message, d: n1[0].send_args.dest }));
	check('аккаунт с меткой записан как paid', (await bal(N1, 'paid')) === 50000000);
	check('ttl_blocks задан (поздний ответ не сможет завершиться после возврата)', wallet.sendCalls.every(a => a.ttl_blocks > 0));
	check('ниже минимума не платили', sentTo('acc-small@epicbox.epiccash.com').length === 0 && (await bal(SMALL, 'balance')) === 500000);

	const failbeforeRefund = logsP.join('').includes('acc-failbefore@epicbox.epiccash.com is returned to the balance');
	check('failbefore: неудачная отправка без транзакции -> возврат на баланс', failbeforeRefund && (await bal(FB, 'paid')) === 0 && txsTo(FB).length === 0);
	const fa = txsTo(FA);
	check('failafter: транзакция найдена в журнале кошелька, выплата не удвоена и не возвращена', fa.length === 1 && (await bal(FA, 'paid')) === 40000000 && !logsP.join('').includes('acc-failafter@epicbox.epiccash.com is returned'),
		`txs=${fa.length} paid=${await bal(FA, 'paid')}`);
	check('noanswer: транзакция отменена в кошельке и сумма возвращена', wallet.cancelCalls.length >= 1 && logsP.join('').includes('acc-noanswer@epicbox.epiccash.com is returned to the balance') && (await bal(NA, 'paid')) === 0);
	check('notenough: NotEnoughFunds -> сумма сразу вернулась на баланс, ничего не отправлено, записи pending нет',
		logsP.join('').includes('The wallet cannot fund 0.60000000 EPIC to acc-notenough@epicbox.epiccash.com') && txsTo(NE).length === 0 && (await bal(NE, 'balance')) === 60000000 && (await bal(NE, 'pending')) === 0);
	const pay = await rc('zrange', COIN + ':payments:all', 0, -1);
	check('payments:all: kernel_excess:сумма:комиссия:0:1:высота блока (ссылка на обозреватель)', pay.length >= 5 && pay.every(p => /^09[0-9a-f]{64}:\d+:800000:0:1:1000$/.test(p)), pay[0]);
	check('payments:<account> записан', (await rc('zcard', COIN + ':payments:' + A2)) === 1);
	check('в pending пусто, кроме повторных попыток недоступных получателей', Object.keys((await rc('hgetall', COIN + ':payments:pending')) || {}).length <= 2);

	// ------------- dry run and a wallet without funds
	console.log('--- dry run / нехватка средств');
	await rc('flushdb');
	wallet.sendCalls.length = 0; wallet.txs.length = 0;
	await rc('hset', COIN + ':workers:' + A1, 'balance', 100000000);
	const cfgDry = path.join(os.tmpdir(), 'epic-pay-dry.json');
	makeConfig(cfgDry, { dryRun: true });
	const logsD = [];
	let p = run('payments', cfgDry, logsD);
	await sleep(3500); p.kill(); await sleep(300);
	check('dry run: ничего не отправлено, баланс цел', wallet.sendCalls.length === 0 && (await bal(A1, 'balance')) === 100000000 && logsD.join('').includes('[dry run] would pay 1.00000000 EPIC'));

	wallet.spendable = 50000000;                     // 0.5 EPIC in the wallet, 1 EPIC due
	const cfgLow = path.join(os.tmpdir(), 'epic-pay-low.json');
	makeConfig(cfgLow, {});
	const logsL = [];
	p = run('payments', cfgLow, logsL);
	await sleep(3500); p.kill(); await sleep(300);
	check('мало средств в кошельке: не отправляем, баланс не списан', wallet.sendCalls.length === 0 && (await bal(A1, 'balance')) === 100000000 && logsL.join('').includes('Not enough spendable funds'));

	// ------------- stop file: no new payouts while it exists
	console.log('--- стоп-флаг');
	wallet.spendable = 100000000000;
	wallet.sendCalls.length = 0; wallet.txs.length = 0;
	await rc('flushdb');
	await rc('hset', COIN + ':workers:' + A1, 'balance', 100000000);
	const stopPath = path.join(os.tmpdir(), 'epic-test-STOP');
	fs.writeFileSync(stopPath, '');
	const cfgStop = path.join(os.tmpdir(), 'epic-pay-stop.json');
	makeConfig(cfgStop, { stopFile: stopPath });
	const logsS = [];
	p = run('payments', cfgStop, logsS);
	await sleep(3500);
	check('флаг есть: ничего не отправлено, баланс цел, в журнале PAUSED', wallet.sendCalls.length === 0 && (await bal(A1, 'balance')) === 100000000 && logsS.join('').includes('PAUSED'));
	fs.unlinkSync(stopPath);
	await sleep(3500);
	check('флаг снят: выплата пошла без перезапуска процесса', wallet.sendCalls.length === 1 && (await bal(A1, 'balance')) === 0);
	p.kill(); await sleep(300);

	// ------------- developer donation: a percent of the reward goes to the given address before the miners' shares are computed
	console.log('--- комиссия разработчика');
	await rc('flushdb');
	const DEV = 'esYd2vznULSZPn8yQG1SpViF1xEdSs4Fa4n91tkhdSxZCNVdkBt4@epicbox.epiccash.com';
	await rc('zadd', COIN + ':blocks:candidates', 100, cand('prop', A1, 'hash100', 4000, 4));
	await rc('hset', COIN + ':scores:prop:round100', A1, '3');
	await rc('hset', COIN + ':scores:prop:round100', A2, '1');
	const cfgDon = path.join(os.tmpdir(), 'epic-pay-donation.json');
	makeConfig(cfgDon, { enabled: false }, { donations: { [DEV]: 0.5, 'not-an-address': 1, [DEV + '.5']: 20 } });
	const logsN = [];
	p = run('unlocker', cfgDon, logsN);
	await sleep(4500); p.kill(); await sleep(300);
	// 10 EPIC reward, pool fee 1% (kept by the pool), donation 0.5% -> the miners share 9.85 EPIC 3:1
	check('пожертвование 0.5%: 0.05 EPIC на адрес разработчика', (await bal(DEV, 'balance')) === 5000000, String(await bal(DEV, 'balance')));
	check('майнеры делят 9.85 EPIC (комиссия пула 1% + пожертвование 0.5% вычтены до раздела)', (await bal(A1, 'balance')) === 738750000 && (await bal(A2, 'balance')) === 246250000, `${await bal(A1, 'balance')} / ${await bal(A2, 'balance')}`);
	check('в сумме начислено 9.9 EPIC, 0.1 EPIC (1%) осталась пулу', (await bal(A1, 'balance')) + (await bal(A2, 'balance')) + (await bal(DEV, 'balance')) === 990000000);
	check('неверные записи пожертвований отклонены с сообщением (адрес не валиден, процент вне 0..10)', logsN.join('').includes('Donation entry not-an-address ignored') && logsN.join('').includes('.5 ignored') && !(await rc('exists', COIN + ':workers:not-an-address')));

	ws.close(); ns.close(); r.quit();
	console.log(failed ? `\n${failed} ПРОВЕРОК НЕ ПРОШЛО` : '\nВСЕ ПРОВЕРКИ ПРОШЛИ');
	if (failed) { console.log('\n--- unlocker log\n' + logsU.join('').slice(-1500) + '\n--- payments log\n' + logsP.join('').slice(-3500)); }
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(2); });
