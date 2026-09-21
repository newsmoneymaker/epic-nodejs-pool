# Changes

## Unreleased

* The variable difficulty of the validating pool is remembered per address and worker across reconnects (`poolServer.diffMemoryMinutes`, default 15): a miner whose connection is cut or renewed every half minute no longer restarts from the start difficulty each time.

## 1.1.0

* **New: the pool can check the shares itself** (`poolServer.validateShares: true`, `lib/poolValidating.js`). The node validates one share at a time (about half a
  second each) and has one share difficulty for everybody, so with a busy pool the answers came seconds late, shares of miners whose connection had been cut
  meanwhile were lost, and a fast miner was flooded with shares. Now every miner gets a difficulty of its own (variable difficulty), RandomX shares are checked
  by the pool (helper `hasher/epichash`, RandomX of the Epic node, tested against shares the real node accepted) and answered at once, and only blocks go to
  the node. ProgPow / Cuckoo shares are still relayed. `validateShares: false` keeps the old behaviour.
* Site: the texts about a fixed difficulty are changed.

## 1.0.1

* **Fix: block rewards could not be split.** With slush mining (`poolServer.slushMining.enabled`) the round scores were written to the key
  `<coin>:scores:roundCurrent`, while a found block moves and reads `<coin>:scores:prop:roundCurrent` (and the unlocker `...:round<height>`):
  the block candidate got a score total of 0 and nobody would have been credited. The scores are now written to
  `<coin>:scores:<prop|solo>:roundCurrent`. If you already run 1.0.0 with slush mining, stop the pool once and move the old key:
  `RENAME "<coin>:scores:roundCurrent" "<coin>:scores:prop:roundCurrent"` (solo miners: split by hand), then start the pool on 1.0.1.
  No block had been found on the live pool when this was fixed. The pool test checks it now.

## 1.0.0

First release of the Epic Cash adaptation of [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool) 1.4.1 (GPL-2.0).

Changed compared with the upstream:

* Stratum: a per-connection proxy to the Epic node stratum (RandomX, ProgPow, Cuckoo); shares weighted by difficulty, block detection,
  keepalive, TLS ports, per-IP connection limits, login deadline, optional IP allow list.
* Accounts are epicbox addresses with an optional deposit note (`ADDRESS.123456`, `ADDRESS#note`); `requireNoteDomains` for exchanges.
* Block unlocker: 1440-block coinbase maturity, the reward is the confirmed coinbase output in the pool wallet, orphan detection.
* Payment processor: payouts through the wallet Owner API over epicbox, per-payout state machine in Redis, dry run, whitelist,
  limits, emergency stop file (`deployment/pause-payments.sh`).
* Developer donation (`blockUnlocker.donations`, default 0.5%), included in the pool fee shown on the website and in the API.
* Website: dashboard, blocks, payments, top miners, worker statistics, getting-started page with a config generator, public API page.
* `deployment/` (systemd units, wallet launcher, Redis and Apache examples), `docs/INSTALL.md`, tests with a mock node and a mock wallet.

Removed: CryptoNote daemon and wallet RPC code, cryptonight modules, merged mining, e-mail/Telegram notifications, other coins' examples.
