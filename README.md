# epic-nodejs-pool

Mining pool software for **Epic Cash (EPIC)** written in Node.js: a stratum proxy in front of the Epic node, block accounting through the
pool wallet, and payouts to miners over epicbox. It is a fork of [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool)
by Dvandal (GNU GPL v2), adapted to Epic's stratum protocol and to Mimblewimble payments. Everything specific to CryptoNote coins (daemons,
cryptonight modules, mail and Telegram notifications, merged mining) was removed. Live example: <https://epic.pool-pay.com>.

## What it does

* **Stratum proxy** (plain TCP and TLS ports): every miner connection is relayed to the Epic node's stratum; the pool watches jobs and share
  replies, records shares (RandomX, ProgPow, Cuckoo) weighted by their chance to find a block, and detects found blocks.
* **Accounts** are epicbox addresses: `ADDRESS`, `ADDRESS+worker`, with a reward mode prefix `prop:` / `solo:`, and an optional deposit note for
  exchanges (`ADDRESS.123456` or `ADDRESS#note`). Exchange domains can be listed in `poolServer.requireNoteDomains`: a login without the note
  is refused, so nothing is paid to a shared exchange address without its note.
* **Rewards:** PROP with time weighting (slush) or SOLO.
* **Block unlocker:** a block is settled 1440 blocks after it was found (Epic's coinbase maturity). The reward is the exact value of the
  confirmed coinbase output in the pool wallet (Mimblewimble hides amounts), orphans are recognised, nothing is credited when the outcome
  is unclear.
* **Payment processor:** pays balances from the pool wallet through its Owner API, over epicbox, with the deposit note as the slate message.
  Every payout is a small state machine in Redis (balance debited first, matched against the wallet's transaction log if the outcome is
  unknown, cancelled and returned after a timeout), a dry-run mode, a whitelist for rehearsals, limits per payout and per round, and an
  emergency brake (`deployment/pause-payments.sh`).
* **Website and API:** a ready website (`website_example/`) with the dashboard, blocks, payments, top miners, worker statistics, a "Getting
  started" page with a config generator, and the public read-only JSON API.
* **Protection against connection floods:** limits per IP, a login deadline, an optional IP allow list.
* **Tests** with a mock node and a mock wallet (`test/`).

## Developer donation (please read)

The pool takes a **developer donation** from the reward of every block it finds, before the miners' shares are computed. It is configured in
`config.json` (see `config_examples/epic.json`):

```json
"blockUnlocker": {
  "poolFee": 1,
  "donations": { "esYd2vznULSZPn8yQG1SpViF1xEdSs4Fa4n91tkhdSxZCNVdkBt4@epicbox.epiccash.com": 0.5 }
}
```

* `poolFee` is the fee of the pool operator (percent). `donations` is a table `epicbox address -> percent` (up to 10% per entry) for the
  developers of this software; **the default is 0.5% to the address of the project's own pool**. The donation is paid like any other balance.
* It is included in the "Pool Fee" figure that the pool's website and API show to the miners (as in the original software), so the miners of a
  pool see what they really pay.
* You are free to change the percentage, the address or to empty the table (`"donations": {}`): it is your pool and the license is the GPL.
  Please tell your miners the truth about the fees of your pool.
* This has nothing to do with the miner poolpayminer (a separate project with its own fee).

## Installation

See [docs/INSTALL.md](docs/INSTALL.md): the Epic node and wallet settings, Redis, the pool services (systemd templates in
`deployment/`), the website and the first payout rehearsal.

Requirements: Linux, Node.js 18 or newer, Redis, the Epic node (`epic`, 4.0.x) and wallet (`epic-wallet`, 4.0.x), a web server for the
website and a TLS certificate for the TLS stratum ports.

## Tests

```
npm install
node test/test-account.js        # account and deposit note parsing, needs nothing else
# The others use test/config.test.json and a THROWAWAY Redis on port 16379 (they flush it, never point them at a real database):
redis-server --port 16379 --requirepass CHANGE_ME_REDIS_PASSWORD --save "" --appendonly no &
node test/test-payments.js       # unlocker, donation split and payment processor against a mock wallet and mock node
node test/mock-node.js 13416 &   # mock of the node stratum
node init.js -config=test/config.test.json -module=pool &
node test/test-pool.js 13333 16379 CHANGE_ME_REDIS_PASSWORD 1
```

## Money warning

The payment processor moves real coins. Rehearse first: `"dryRun": true`, then a whitelist (`onlyAccounts`) with a few small payouts of your own,
then enable it. A payout that has been posted to the network can not be cancelled. Keep the wallet password and the Owner API secret private.

## License and credits

GNU GPL v2 (see [LICENSE](LICENSE)). Based on cryptonote-nodejs-pool, Copyright (c) Dvandal and contributors. The Epic node and wallet
(Apache-2.0) are separate programs and are not included.
