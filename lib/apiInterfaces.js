/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Handle communications to APIs
 **/

// Load required modules
var http = require('http');
var https = require('https');

function jsonHttpRequest (host, port, data, callback, path) {
	path = path || '/json_rpc';
	callback = callback || function () {};
	var options = {
		hostname: host,
		port: port,
		path: path,
		method: data ? 'POST' : 'GET',
		headers: {
			'Content-Length': data.length,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		}
	};
	var req = (port === 443 ? https : http)
		.request(options, function (res) {
			var replyData = '';
			res.setEncoding('utf8');
			res.on('data', function (chunk) {
				replyData += chunk;
			});
			res.on('end', function () {
				var replyJson;
				try {
					replyJson = replyData ? JSON.parse(replyData) : {};
				} catch (e) {
					callback(e, {});
					return;
				}
				callback(null, replyJson);
			});
		});

	req.on('error', function (e) {
		callback(e, {});
	});
	req.end(data);
}

/**
 * Send RPC request to pool API
 **/
function poolRpc (host, port, path, callback) {
	jsonHttpRequest(host, port, '', callback, path);
}

/**
 * GET a JSON document from the Epic node HTTP API (/v1/...).
 * The node API listens on config.node.api (default 127.0.0.1:3413).
 **/
function nodeApi (path, callback) {
	var nodeApiConfig = (config.node && config.node.api) || {host: '127.0.0.1', port: 3413};
	var done = false;
	function finish (error, data) {
		if (done) return;
		done = true;
		callback(error, data);
	}

	var req = http.request({
		hostname: nodeApiConfig.host,
		port: nodeApiConfig.port,
		path: path,
		method: 'GET',
		headers: {'Accept': 'application/json'},
		timeout: 5000
	}, function (res) {
		var body = '';
		res.setEncoding('utf8');
		res.on('data', function (chunk) {
			body += chunk;
			if (body.length > 8 * 1024 * 1024) req.destroy(new Error('node api reply too large'));
		});
		res.on('end', function () {
			if (res.statusCode !== 200) return finish(new Error('node api ' + path + ' returned HTTP ' + res.statusCode), null);
			try {
				finish(null, JSON.parse(body));
			} catch (e) {
				finish(e, null);
			}
		});
	});
	req.on('timeout', function () {
		req.destroy(new Error('node api timeout for ' + path));
	});
	req.on('error', function (e) {
		finish(e, null);
	});
	req.end();
}

/**
 * Exports API interfaces functions
 **/
module.exports = function (daemonConfig, walletConfig, poolApiConfig) {
	return {
		nodeApi: nodeApi,
		pool: function (path, callback) {
			var bindIp = config.api.bindIp ? config.api.bindIp : "0.0.0.0";
			var poolApi = (bindIp !== "0.0.0.0" ? poolApiConfig.bindIp : "127.0.0.1");
			poolRpc(poolApi, poolApiConfig.port, path, callback);
		},
		jsonHttpRequest: jsonHttpRequest
	}
};
