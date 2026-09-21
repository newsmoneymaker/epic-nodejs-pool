# Installing an Epic Cash pool

Paths below are examples: the pool in `/opt/epic-nodejs-pool`, the wallet in `/opt/epic-wallet`, the node in `/opt/epic-node`, all run by
the user `epicpool` (systemd templates in `deployment/systemd/` use these paths).

## 1. Epic node

Build or download `epic` (EpicCash/epic 4.0.x) and let it sync (a bootstrap file shortens it). In `epic-server.toml`:

```toml
[server.stratum_mining_config]
enable_stratum_server = true
stratum_server_addr = "127.0.0.1:3416"        # the pool connects here; never expose it to the internet
randomx_minimum_share_difficulty = 4000       # fixed share difficulty per algorithm (there is no vardiff)
progpow_minimum_share_difficulty = 200000
cuckatoo_minimum_share_difficulty = 3
wallet_listener_url = "http://127.0.0.1:3415" # the wallet that receives the block rewards
burn_reward = false
```

The node builds jobs only while at least one miner is connected. Its API stays on 127.0.0.1:3413.

## 2. Pool wallet

```
epic-wallet init -w        # in /opt/epic-wallet; write the seed phrase down and keep it offline
```
In `epic-wallet.toml`: `check_node_api_http_addr = "http://127.0.0.1:3413"`, `api_listen_port = 3415`, `owner_api_listen_port = 3420`,
`api_secret_path = ".owner_api_secret"`, `use_tor_listener = false`. Put the wallet password into `/opt/epic-wallet/wallet.pass` (mode 600).
Three wallet processes are needed (units `epic-wallet`, `epic-wallet-owner`, `epic-wallet-epicbox`; `deployment/wallet/run-wallet.py` types the
password at the wallet prompt so it never shows up in the process list):

* `listen --no_tor`: HTTP listener 127.0.0.1:3415, receives the block rewards from the node;
* `owner_api -l 3420`: JSON-RPC Owner API, used by the pool to pay (basic auth: user `epic`, the secret from `.owner_api_secret`);
* `listen -m epicbox`: receives transfers to the pool's epicbox address and the answers of the miners' wallets (it finalizes the payouts).

`epic-wallet address` shows the pool's epicbox address (it is also the natural address for a developer donation).

## 3. Redis

Use a dedicated instance with a password and AOF (`deployment/redis-pool.conf.example`, unit `epic-pool-redis`).

## 3a. RandomX helper (validating mode)

With `poolServer.validateShares: true` the pool checks RandomX shares itself. The helper must use the RandomX **of the Epic node**
(github.com/EpicCash/randomx: other instruction frequencies and AES keys than Monero's), not the stock one:

```
git clone https://github.com/EpicCash/randomx && cd randomx && mkdir build && cd build
cmake .. -DARCH=native -DBUILD_SHARED_LIBS=OFF && make -j4 randomx
mkdir -p /opt/epic-randomx/include /opt/epic-randomx/lib && cp ../src/randomx.h /opt/epic-randomx/include && cp librandomx.a /opt/epic-randomx/lib
cd /opt/epic-nodejs-pool/hasher && EPICRANDOMX=/opt/epic-randomx make epichash
```

Set `hasher.path` in `config.json` (see `config_examples/epic.json`). The helper needs about 2.3 GB of RAM (the RandomX dataset); `"hasher": {"light": true}`
uses 256 MB and is much slower. Every time the RandomX key of the node changes (an epoch) the pool rebuilds the dataset (about 10 seconds without new jobs).

## 4. The pool

```
cd /opt/epic-nodejs-pool && npm install --production
cp config_examples/epic.json config.json      # then edit it, see below
```

Edit `config.json`: `poolHost`, the ports and the certificate for TLS (`poolServer.sslCert/sslKey`), `redis`, `api.password`, `wallet.secretFile`,
`blockUnlocker.poolFee` and `donations`, `payments`. **Keep `payments.dryRun: true` until the rehearsal below.** Start the services:

```
cp deployment/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now epic-pool-redis epic-node epic-wallet epic-wallet-owner epic-wallet-epicbox
systemctl enable --now epic-pool epic-pool-api epic-pool-unlocker epic-pool-payments
```

The pool runs as separate modules (`init.js -module=pool|api|unlocker|payments`), each in its own unit.
Until payouts are proven, restrict the stratum ports with `poolServer.allowIPs`.

## 5. Website

Copy `website_example/` to the web root, set `poolHost`, the contact and links in `config.js`, and proxy `/api` to the pool API on 127.0.0.1:8117
(`deployment/apache-vhost.conf.example` exposes only the read-only methods).

## 6. Rehearse the payments

1. `payments.dryRun: true`: the log of `epic-pool-payments` shows what would be paid.
2. Fund the pool wallet with a few coins (a normal transfer to its epicbox address: it can be spent after 10 confirmations), create test wallets
   on the same server, credit them small balances in Redis (`<coin>:workers:<address>` field `balance`), set `payments.onlyAccounts` to them,
   `dryRun: false`, and watch the payouts complete.
3. Remove the test accounts from Redis and set `onlyAccounts` to `[]`.

Good to know: the wallet pays one payout at a time per unspent output (the change is locked until it confirms); the pool pays the network fee of
its payouts; block rewards can be spent only after 1440 blocks; `deployment/pause-payments.sh` stops new payouts at once.
