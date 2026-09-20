// Unit checks of the account parsing (address + optional deposit note). Run: node test-account.js
const path = require('path');
const u = require(path.join(__dirname, '../lib/utils.js'));

const KEY = 'esYd2vznULSZPn8yQG1SpViF1xEdSs4Fa4n91tkhdSxZCNVdkBt4';       // the pool's own public address
const EXCH = 'esXnCQUxaAqmVFdhNK2McAVqTrf4Urhy9n33Mhv8hnX1jGjN5Kqv';      // an exchange deposit address (public)
let failed = 0;
function check (name, actual, expected) {
	let ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : '\n   got ' + JSON.stringify(actual) + '\n   exp ' + JSON.stringify(expected));
}
const acc = s => { let p = u.parseMinerAccount(s); return p && {account: p.account, note: p.note, domain: p.domain}; };

check('own wallet, default domain', acc(`${KEY}@epicbox.epiccash.com`), {account: `${KEY}@epicbox.epiccash.com`, note: null, domain: 'epicbox.epiccash.com'});
check('own wallet, bare key', acc(KEY), {account: `${KEY}@epicbox.epiccash.com`, note: null, domain: 'epicbox.epiccash.com'});
check('exchange address without note', acc(`${EXCH}@epicbox.nonkyc.io`), {account: `${EXCH}@epicbox.nonkyc.io`, note: null, domain: 'epicbox.nonkyc.io'});
check('note after a dot (digits)', acc(`${EXCH}@epicbox.nonkyc.io.123456`), {account: `${EXCH}@epicbox.nonkyc.io#123456`, note: '123456', domain: 'epicbox.nonkyc.io'});
check('note after a hash (letters)', acc(`${EXCH}@epicbox.nonkyc.io#abc-12_X`), {account: `${EXCH}@epicbox.nonkyc.io#abc-12_X`, note: 'abc-12_X', domain: 'epicbox.nonkyc.io'});
check('note with bare key + dot', acc(`${KEY}.42`), {account: `${KEY}@epicbox.epiccash.com#42`, note: '42', domain: 'epicbox.epiccash.com'});
check('same account typed two ways', acc(`${EXCH}@epicbox.nonkyc.io.7`).account, acc(`${EXCH}@epicbox.nonkyc.io#7`).account);
check('IPv4 domain is not a note', acc(`${KEY}@10.0.0.4`), {account: `${KEY}@10.0.0.4`, note: null, domain: '10.0.0.4'});
check('IPv4 domain + hash note', acc(`${KEY}@10.0.0.4#9`), {account: `${KEY}@10.0.0.4#9`, note: '9', domain: '10.0.0.4'});
check('explicit port 443 + note', acc(`${KEY}@epicbox.example.com:443.5`), {account: `${KEY}@epicbox.example.com#5`, note: '5', domain: 'epicbox.example.com'});
check('other port rejected', acc(`${KEY}@epicbox.example.com:8080.5`), null);
check('bad checksum rejected', acc('esYd2vznULSZPn8yQG1SpViF1xEdSs4Fa4n91tkhdSxZCNVdkBt5@epicbox.epiccash.com'), null);
check('note too long rejected', acc(`${KEY}@epicbox.epiccash.com.` + '1'.repeat(33)), null);
check('junk rejected', acc('hello.123'), null);
check('empty note rejected', acc(`${KEY}@epicbox.epiccash.com#`), null);
check('split back (note)', u.splitMinerAccount(`${EXCH}@epicbox.nonkyc.io#123`), {address: `${EXCH}@epicbox.nonkyc.io`, note: '123'});
check('split back (no note)', u.splitMinerAccount(`${KEY}@epicbox.epiccash.com`), {address: `${KEY}@epicbox.epiccash.com`, note: null});
check('canonical of typed text', u.canonicalMinerAccount(`${EXCH}@EPICBOX.NONKYC.IO.123`), `${EXCH}@epicbox.nonkyc.io#123`);

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
