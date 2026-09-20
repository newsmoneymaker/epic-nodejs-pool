#!/bin/sh
# Emergency brake: no NEW payouts start while this file exists (payouts already in flight are still settled). Undo: resume-payments.sh
cd "$(dirname "$0")/.." && touch STOP_PAYMENTS && echo "payments PAUSED ($(pwd)/STOP_PAYMENTS exists)"
