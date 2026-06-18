#!/usr/bin/env bash
# Curva di scaling sui NODI (Condizione 2): per N=1,2,3 ricrea il cluster shardato
# con N shard PRE-SPLIT, carica i lotti e misura. Metodologia pulita: distribuzione
# all'inserimento (hash del CIG), niente migrazione del balancer né documenti orfani.
set -e
LOAD=${LOAD:-150000}
rm -f ../benchmarks/shard-bench.jsonl   # parte pulito → 3 righe (N=1,2,3) per i grafici
echo "| shard | lotti | distribuzione | SCRITTURA doc/s | Q agg (scatter-gather) p50/p95 | Q puntuale p50/p95 |"
echo "|---|---|---|---|---|---|"
for N in ${NSHARDS_LIST:-1 2 3 4 5}; do
  docker compose -f docker-compose.shard.yml down -v >/dev/null 2>&1 || true
  docker compose -f docker-compose.shard.yml up -d >/dev/null 2>&1
  NSHARDS=$N bash scripts/shard-setup.sh >/dev/null 2>&1
  LOAD=$LOAD npx tsx scripts/bench-shard.ts
done
docker compose -f docker-compose.shard.yml down -v >/dev/null 2>&1 || true
echo "(scatter-gather: l'aggregazione gira in parallelo sugli shard → la latenza cala con i nodi; la puntuale per CIG colpisce 1 shard → ~costante)"
