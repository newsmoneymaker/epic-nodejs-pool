/**
 * Epic Cash Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Utilities functions
 **/

// Load required module
let crypto = require('crypto');

let dateFormat = require('dateformat');
exports.dateFormat = dateFormat;

/**
 * Generate random instance id
 **/
exports.instanceId = function () {
	return crypto.randomBytes(4);
}

/**
 * Epicbox address handling.
 * Epic has no on-chain addresses: a miner is identified by the epicbox address of
 * his wallet: <52 base58 chars>[@domain[:port]], where the base58 part is
 * base58check(version[1,0] + 33-byte compressed secp256k1 pubkey).
 **/
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const EPICBOX_VERSION = Buffer.from([1, 0]);
const EPICBOX_DEFAULT_DOMAIN = 'epicbox.epiccash.com';
const EPICBOX_REGEX = /^(?:epicbox:\/\/)?([123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{52})(?:@([a-zA-Z0-9.\-]+)(?::([0-9]+))?)?$/;

function base58Decode (str) {
	let num = 0n;
	for (let ch of str) {
		let idx = B58.indexOf(ch);
		if (idx < 0) return null;
		num = num * 58n + BigInt(idx);
	}
	let hex = num.toString(16);
	if (hex.length % 2) hex = '0' + hex;
	let bytes = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
	let zeros = 0;
	while (zeros < str.length && str[zeros] === '1') zeros++;
	return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

function sha256d (buf) {
	let h1 = crypto.createHash('sha256').update(buf).digest();
	return crypto.createHash('sha256').update(h1).digest();
}

/**
 * Parse and validate an epicbox address.
 * Returns {publicKey, domain, port, canonical} or null if invalid.
 * `canonical` = publicKey@domain[:port] (port omitted when 443, as in epic-wallet),
 * so one wallet always maps to one miner identity.
 **/
function parseMinerAddress (address) {
	if (typeof address !== 'string' || address.length > 200) return null;
	let m = EPICBOX_REGEX.exec(address);
	if (!m) return null;

	let raw = base58Decode(m[1]);
	if (!raw || raw.length !== 2 + 33 + 4) return null;

	let payload = raw.slice(0, 35);
	let checksum = raw.slice(35);
	if (!sha256d(payload).slice(0, 4).equals(checksum)) return null;
	if (!payload.slice(0, 2).equals(EPICBOX_VERSION)) return null;
	if (payload[2] !== 0x02 && payload[2] !== 0x03) return null; // compressed pubkey prefix

	let domain = (m[2] || EPICBOX_DEFAULT_DOMAIN).toLowerCase();
	let port = m[3] ? parseInt(m[3]) : null;
	if (port !== null && (port < 1 || port > 65535)) return null;
	// The login is stored in ':'-separated redis members (hashrate, block candidates),
	// so addresses with a non-default epicbox port are not supported by this pool.
	if (port !== null && port !== 443) return null;

	let canonical = m[1] + '@' + domain;
	return { publicKey: m[1], domain: domain, port: port, canonical: canonical };
}
exports.parseMinerAddress = parseMinerAddress;

// Validate miner address
exports.validateMinerAddress = function (address) {
	return parseMinerAddress(address) !== null;
}

// Canonical form of a valid address, or null
exports.canonicalMinerAddress = function (address) {
	let parsed = parseMinerAddress(address);
	return parsed ? parsed.canonical : null;
}

/**
 * Miner account = epicbox address + optional deposit note (like a payment ID). Exchanges give every customer the same
 * shared address and tell customers apart by a note that has to travel with the payout (the "message" of the slate).
 *
 * Accepted in a login:   KEY@domain            wallet of your own, no note
 *                        KEY@domain.123456     note written like a Monero payment ID (digits only after the last dot)
 *                        KEY@domain#abc-12     note with letters (up to 64 of A-Za-z0-9_-)
 * Canonical account:     KEY@domain  or  KEY@domain#NOTE   (this is the key of everything stored in redis)
 * A domain never ends with a number, so a trailing ".digits" is a note, except in front of an IPv4 address.
 **/
const NOTE_SUFFIX = /^(.+?)(?:\.([0-9]{1,32})|#([A-Za-z0-9_\-]{1,64}))$/;
const IPV4_TAIL = /@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?$/;

function parseMinerAccount (input) {
	if (typeof input !== 'string' || input.length > 300) return null;

	let base = input;
	let note = null;
	let m = IPV4_TAIL.test(input) ? null : NOTE_SUFFIX.exec(input);
	if (m) {
		base = m[1];
		note = m[2] || m[3];
	}

	let parsed = parseMinerAddress(base);
	if (!parsed) return null;

	// what is left of the input must not look like a domain with a number at the end (an unrecognised note)
	if (/\.\d+$/.test(parsed.domain) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.domain)) return null;

	return {
		publicKey: parsed.publicKey,
		domain: parsed.domain,
		address: parsed.canonical,
		note: note,
		account: note ? parsed.canonical + '#' + note : parsed.canonical
	};
}
exports.parseMinerAccount = parseMinerAccount;

// Canonical account of a login/address as typed by a person, or null
exports.canonicalMinerAccount = function (input) {
	let parsed = parseMinerAccount(input);
	return parsed ? parsed.account : null;
}

// Split a stored account back into {address, note}
exports.splitMinerAccount = function (account) {
	let hash = account.indexOf('#');
	return hash === -1 ? {address: account, note: null} : {address: account.substring(0, hash), note: account.substring(hash + 1)};
}


/**
 * Developer donation table of the config: blockUnlocker.donations = {"<epicbox address>[.note]": percent of the block reward}.
 * Returns {canonical account: percent} of the valid entries (percent above 0 up to 10); onInvalid(address) is called for the others.
 **/
exports.donationTable = function (unlockerConfig, onInvalid) {
	let table = {};
	let entries = (unlockerConfig && unlockerConfig.donations) || {};
	Object.keys(entries).forEach(function (address) {
		let account = exports.canonicalMinerAccount(address);
		let percent = parseFloat(entries[address]);
		if (!account || !(percent > 0) || percent > 10) {
			if (onInvalid) onInvalid(address);
			return;
		}
		table[account] = percent;
	});
	return table;
};

function characterCount (string, char) {
	let re = new RegExp(char, "gi")
	let matches = string.match(re)
	return matches === null ? 0 : matches.length;
}
exports.characterCount = characterCount;

exports.determineRewardData = (value) => {
	let calculatedData = {
		'address': value,
		'rewardType': 'prop'
	}
	if (/^solo:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'solo'
		return calculatedData
	}
	if (/^prop:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'prop'
		return calculatedData
	}
	return calculatedData
}

/**
 * Cleanup special characters (fix for non latin characters)
 **/
function cleanupSpecialChars (str) {
	str = str.replace(/[ÀÁÂÃÄÅ]/g, "A");
	str = str.replace(/[àáâãäå]/g, "a");
	str = str.replace(/[ÈÉÊË]/g, "E");
	str = str.replace(/[èéêë]/g, "e");
	str = str.replace(/[ÌÎÏ]/g, "I");
	str = str.replace(/[ìîï]/g, "i");
	str = str.replace(/[ÒÔÖ]/g, "O");
	str = str.replace(/[òôö]/g, "o");
	str = str.replace(/[ÙÛÜ]/g, "U");
	str = str.replace(/[ùûü]/g, "u");
	return str.replace(/[^A-Za-z0-9\-\_+]/gi, '');
}
exports.cleanupSpecialChars = cleanupSpecialChars;

/**
 * Get readable hashrate
 **/
exports.getReadableHashRate = function (hashrate) {
	let i = 0;
	let byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH'];
	while (hashrate > 1000) {
		hashrate = hashrate / 1000;
		i++;
	}
	return hashrate.toFixed(2) + byteUnits[i] + '/sec';
}

/**
 * Get readable coins
 **/
exports.getReadableCoins = function (coins, digits, withoutSymbol) {
	let coinDecimalPlaces = config.coinDecimalPlaces || config.coinUnits.toString().length - 1;
	let amount = (parseInt(coins || 0) / config.coinUnits).toFixed(digits || coinDecimalPlaces);
	return amount + (withoutSymbol ? '' : (' ' + config.symbol));
}

/**
 * Generate unique id
 **/
exports.uid = function () {
	let min = 100000000000000;
	let max = 999999999999999;
	let id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

/**
 * Ring buffer
 **/
exports.ringBuffer = function (maxSize) {
	let data = [];
	let cursor = 0;
	let isFull = false;

	return {
		append: function (x) {
			if (isFull) {
				data[cursor] = x;
				cursor = (cursor + 1) % maxSize;
			} else {
				data.push(x);
				cursor++;
				if (data.length === maxSize) {
					cursor = 0;
					isFull = true;
				}
			}
		},
		avg: function (plusOne) {
			let sum = data.reduce(function (a, b) {
				return a + b
			}, plusOne || 0);
			return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0));
		},
		size: function () {
			return isFull ? maxSize : cursor;
		},
		clear: function () {
			data = [];
			cursor = 0;
			isFull = false;
		}
	};
};
