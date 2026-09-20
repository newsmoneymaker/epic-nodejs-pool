#!/usr/bin/env python3
"""Runs `epic-wallet <args>` in the wallet directory and types the wallet password at its prompt through a pty, so that the password
never appears in the process command line (/proc/<pid>/cmdline is readable by other local users).

    run-wallet.py <wallet-dir> <epic-wallet arguments...>      e.g.   run-wallet.py /opt/epic-wallet listen --no_tor

The password is read from <wallet-dir>/wallet.pass (mode 600). The binary is taken from $EPIC_WALLET (default /usr/local/bin/epic-wallet).
SIGTERM/SIGINT are forwarded to the wallet; the exit status of the wallet is the exit status of this script."""
import os, pty, re, select, signal, sys, time

WALLET = os.environ.get("EPIC_WALLET", "/usr/local/bin/epic-wallet")
if len(sys.argv) < 3:
    sys.exit(__doc__)
wallet_dir, args = sys.argv[1], sys.argv[2:]
with open(os.path.join(wallet_dir, "wallet.pass"), "rb") as f:
    password = f.read().strip()

pid, fd = pty.fork()
if pid == 0:
    os.chdir(wallet_dir)
    os.execv(WALLET, [WALLET] + args)

def forward(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)

sent, tail = False, b""
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 1.0)
    except InterruptedError:
        continue
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        if not data:
            break
        sys.stdout.buffer.write(data); sys.stdout.flush()
        tail = (tail + data)[-200:]
        if not sent and re.search(rb"assword", tail, re.I):
            time.sleep(0.3); os.write(fd, password + b"\n"); sent = True
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
