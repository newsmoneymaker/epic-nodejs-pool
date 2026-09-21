// veilhash: share validation helper for the Veil pool.
// Reads commands on stdin, writes answers on stdout (one line each):
//   K <64 hex>            set the RandomX key (= the key block hash in the byte order given by the node's RPC, reversed
//                         by the caller, i.e. the raw bytes fed to randomx_init_cache); answers "K ok" or "K err"
//   H <id> <hex blob>     hash = RandomX( SHA256d(blob) ); answers "H <id> <64 hex of the RandomX output>"
//                         with --raw the blob is hashed as it is: hash = RandomX(blob) (Epic Cash)
//   Q                     quit
// Veil's proof of work: RandomX (stock configuration) over the double SHA-256 of the 148 byte header blob.
#include <randomx.h>
#include <openssl/sha.h>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

struct Task { std::string id; std::string blob; };

static std::mutex qm, om;
static std::condition_variable qcv;
static std::deque<Task> queue;
static bool quitting = false;
static int busy = 0;

static randomx_flags flags;
static randomx_cache *cache = nullptr;
static randomx_dataset *dataset = nullptr;
static std::vector<randomx_vm *> vms;
static bool fastMode = true;
static bool rawMode = false;      // --raw: RandomX over the blob itself (no SHA-256d)
static bool haveKey = false;

static bool fromHex(const std::string &s, std::string &out) {
	if (s.size() % 2) return false;
	out.clear(); out.reserve(s.size() / 2);
	for (size_t i = 0; i < s.size(); i += 2) {
		int hi = isxdigit((unsigned char)s[i]) ? (isdigit((unsigned char)s[i]) ? s[i] - '0' : (tolower(s[i]) - 'a' + 10)) : -1;
		int lo = isxdigit((unsigned char)s[i + 1]) ? (isdigit((unsigned char)s[i + 1]) ? s[i + 1] - '0' : (tolower(s[i + 1]) - 'a' + 10)) : -1;
		if (hi < 0 || lo < 0) return false;
		out.push_back((char)(hi * 16 + lo));
	}
	return true;
}

static std::string toHex(const unsigned char *p, size_t n) {
	static const char *d = "0123456789abcdef";
	std::string s; s.reserve(n * 2);
	for (size_t i = 0; i < n; i++) { s.push_back(d[p[i] >> 4]); s.push_back(d[p[i] & 15]); }
	return s;
}

static void say(const std::string &line) {
	std::lock_guard<std::mutex> l(om);
	fputs(line.c_str(), stdout); fputc('\n', stdout); fflush(stdout);
}

static void worker(size_t idx) {
	for (;;) {
		Task t;
		{
			std::unique_lock<std::mutex> l(qm);
			qcv.wait(l, [] { return quitting || !queue.empty(); });
			if (quitting) return;
			t = std::move(queue.front()); queue.pop_front(); busy++;
		}
		unsigned char h1[32], h2[32], out[RANDOMX_HASH_SIZE];
		if (rawMode) {
			randomx_calculate_hash(vms[idx], t.blob.data(), t.blob.size(), out);
		} else {
			SHA256((const unsigned char *)t.blob.data(), t.blob.size(), h1);
			SHA256(h1, 32, h2);
			randomx_calculate_hash(vms[idx], h2, 32, out);
		}
		say("H " + t.id + " " + toHex(out, RANDOMX_HASH_SIZE));
		{
			std::lock_guard<std::mutex> l(qm); busy--;
		}
		qcv.notify_all();
	}
}

int main(int argc, char **argv) {
	int threads = 2;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--light")) fastMode = false;
		else if (!strcmp(argv[i], "--raw")) rawMode = true;
		else if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = atoi(argv[++i]);
	}
	if (threads < 1) threads = 1;
	flags = randomx_get_flags();
	if (fastMode) flags = (randomx_flags)(flags | RANDOMX_FLAG_FULL_MEM);
	std::vector<std::thread> pool;
	std::string line;
	// workers are started after the first key (VMs need the cache/dataset)
	while (std::getline(std::cin, line)) {
		std::istringstream is(line);
		std::string cmd; is >> cmd;
		if (cmd == "Q") break;
		if (cmd == "K") {
			std::string hex, key; is >> hex;
			if (!fromHex(hex, key) || key.size() != 32) { say("K err"); continue; }
			// drain: wait for the workers to be idle and stop them
			{
				std::unique_lock<std::mutex> l(qm);
				qcv.wait(l, [] { return queue.empty() && busy == 0; });
				quitting = true;
			}
			qcv.notify_all();
			for (auto &t : pool) t.join();
			pool.clear();
			for (auto vm : vms) randomx_destroy_vm(vm);
			vms.clear();
			quitting = false;
			if (!cache) cache = randomx_alloc_cache((randomx_flags)(flags | RANDOMX_FLAG_JIT));
			if (!cache) { flags = (randomx_flags)(flags & ~RANDOMX_FLAG_JIT); cache = randomx_alloc_cache(flags); }
			if (!cache) { say("K err"); continue; }
			randomx_init_cache(cache, key.data(), key.size());
			if (fastMode) {
				if (!dataset) dataset = randomx_alloc_dataset(flags);
				if (!dataset) { say("K err"); continue; }
				unsigned long items = randomx_dataset_item_count();
				std::vector<std::thread> init;
				for (int i = 0; i < threads; i++) {
					unsigned long a = items * i / threads, b = items * (i + 1) / threads;
					init.emplace_back([=] { randomx_init_dataset(dataset, cache, a, b - a); });
				}
				for (auto &t : init) t.join();
			}
			for (int i = 0; i < threads; i++) {
				randomx_vm *vm = randomx_create_vm(flags, fastMode ? nullptr : cache, fastMode ? dataset : nullptr);
				if (!vm) { say("K err"); vms.clear(); break; }
				vms.push_back(vm);
			}
			if ((int)vms.size() != threads) continue;
			for (int i = 0; i < threads; i++) pool.emplace_back(worker, (size_t)i);
			haveKey = true;
			say("K ok");
		} else if (cmd == "H") {
			std::string id, hex, blob; is >> id >> hex;
			if (!haveKey || !fromHex(hex, blob)) { say("H " + id + " err"); continue; }
			{ std::lock_guard<std::mutex> l(qm); queue.push_back({id, blob}); }
			qcv.notify_one();
		}
	}
	{ std::lock_guard<std::mutex> l(qm); quitting = true; }
	qcv.notify_all();
	for (auto &t : pool) t.join();
	return 0;
}
