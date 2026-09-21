/**
 * Epic Cash Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Wrapper around the hashing helper (hasher/veilhash.cpp built as epichash, run with --raw): RandomX(blob) of the Epic node for share validation.
 * Settings in config.hasher: {path, args, threads, light}
 *   setKey(keyHex, cb)   the RandomX key (raw bytes), the process re-initialises its dataset (10-60 s)
 *   hash(blobHex, cb)    cb(err, hashHex): 32 raw bytes of the RandomX output
 * The helper is restarted when it dies; the current key is set again.
 **/
let spawn = require('child_process').spawn;
let path = require('path');

let hasherConfig = config.hasher || {};

let child = null;
let buffer = '';
let currentKey = null;
let ready = false;
let waitingKey = null;          // callbacks for "K ok"
let pending = new Map();        // id -> callback
let nextId = 1;
let restartTimer = null;
let log_ = function (level, text, args) { log(level, 'hasher', text, args || []); };

function start () {
	let file = hasherConfig.path || path.join(__dirname, '..', 'hasher', 'epichash');
	let args = (hasherConfig.args || ['--raw']).concat(['--threads', String(hasherConfig.threads || 2)]);
	if (hasherConfig.light) args.push('--light');
	child = spawn(file, args, {stdio: ['pipe', 'pipe', 'inherit']});
	buffer = '';
	ready = false;

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', function (data) {
		buffer += data;
		let idx;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			let line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			onLine(line);
		}
	});
	child.stdin.on('error', function () {});
	child.on('error', function (err) {
		log_('error', 'Cannot run %s: %s', [file, err.message]);
	});
	child.on('exit', function (code, signal) {
		log_('error', 'veilhash exited (code %s, signal %s), restarting in 3 s', [code, signal]);
		child = null;
		ready = false;
		// answer everything that was waiting
		pending.forEach(function (cb) { cb(new Error('hasher restarted')); });
		pending.clear();
		if (waitingKey) { waitingKey.forEach(function (cb) { cb(new Error('hasher restarted')); }); waitingKey = null; }
		clearTimeout(restartTimer);
		restartTimer = setTimeout(function () {
			start();
			if (currentKey) exports.setKey(currentKey, function () {});
		}, 3000);
	});
}

function onLine (line) {
	let parts = line.split(' ');
	if (parts[0] === 'K') {
		let cbs = waitingKey || [];
		waitingKey = null;
		if (parts[1] === 'ok') ready = true;
		cbs.forEach(function (cb) { cb(parts[1] === 'ok' ? null : new Error('key rejected by the hasher')); });
	} else if (parts[0] === 'H') {
		let cb = pending.get(parts[1]);
		if (!cb) return;
		pending.delete(parts[1]);
		if (parts[2] === 'err') cb(new Error('hasher error')); else cb(null, parts[2]);
	}
}

exports.isReady = function () { return ready; };

exports.setKey = function (keyHex, callback) {
	if (!child) start();
	currentKey = keyHex;
	ready = false;
	(waitingKey = waitingKey || []).push(callback || function () {});
	child.stdin.write('K ' + keyHex + '\n');
};

exports.hash = function (blobHex, callback) {
	if (!child || !ready) return callback(new Error('hasher not ready'));
	let id = 'j' + (nextId++);
	pending.set(id, callback);
	child.stdin.write('H ' + id + ' ' + blobHex + '\n');
};

exports.stop = function () {
	clearTimeout(restartTimer);
	if (child) {
		child.removeAllListeners('exit');
		child.stdin.write('Q\n');
		child = null;
	}
};
