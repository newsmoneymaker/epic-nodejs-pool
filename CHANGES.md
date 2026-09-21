# Changes

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
