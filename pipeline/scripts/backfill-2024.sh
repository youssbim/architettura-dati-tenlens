#!/usr/bin/env bash
# Backfill di tutti i 12 mesi OCDS 2024.
# Esegue ingest + sync per ogni mese in sequenza, registra timing.
set -eu
cd "$(dirname "$0")/.."

LOG=/tmp/tenlens-backfill-2024.log
echo "==> backfill 2024 started at $(date)" | tee "$LOG"

for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
  echo "" | tee -a "$LOG"
  echo "==> month 2024-$m" | tee -a "$LOG"
  YEAR=2024 MONTH="$m" npm run ingest:ocds 2>&1 | tee -a "$LOG" | grep -E "done|HTTP|flushed" || true
  echo "==> sync 2024-$m" | tee -a "$LOG"
  npm run graph:sync:ocds 2>&1 | tee -a "$LOG" | tail -5
done

echo "" | tee -a "$LOG"
echo "==> backfill complete at $(date)" | tee -a "$LOG"
