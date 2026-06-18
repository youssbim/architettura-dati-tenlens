// BENCHMARK throughput di SCRITTURA del DB (Condizione 1 — ingestion lato DB).
// NIENTE API: i documenti sono già in memoria; si misura quanti doc/s Mongo
// riesce a scrivere, e se il throughput DEGRADA man mano che la collezione
// cresce (manutenzione degli indici). Indici realistici (come `lotti`).
// Uso: BLOCK=100000 ROUNDS=5 npm run bench:ingest-db

import { db, closeClient } from "../lib/mongo";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";

const OUT = "../benchmarks/ingest-scale.jsonl";
const BLOCK = Number(process.env.BLOCK ?? 100000); // doc per round
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const BATCH = 5000;
const TMP = "_bench_ingest";

async function main(): Promise<void> {
  const d = await db();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // sorgente: BLOCK lotti reali in memoria, senza _id/embedding (per re-inserirli con id nuovi)
  console.log(`→ carico ${BLOCK} doc sorgente in memoria…`);
  const src = await d.collection("lotti").find({}, { projection: { embedding: 0, _embedText: 0, _id: 0 } }).limit(BLOCK).toArray() as any[];

  const c = d.collection(TMP);
  await c.drop().catch(() => {});
  await c.createIndex({ "stazioneAppaltante.cf": 1 });
  await c.createIndex({ "aggiudicazioni.impresa.cf": 1 });

  mkdirSync("../benchmarks", { recursive: true });
  rmSync(OUT, { force: true });
  console.log(`\n| dimensione collezione | doc scritti | tempo | throughput |`);
  console.log(`|---|---|---|---|`);
  let total = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < src.length; i += BATCH) {
      const batch = src.slice(i, i + BATCH).map((doc) => ({ ...doc })); // copia → nuovi ObjectId
      await c.insertMany(batch, { ordered: false });
    }
    const ms = performance.now() - t0;
    total += src.length;
    const rate = (src.length / (ms / 1000));
    console.log(`| → ${(total / 1000).toFixed(0)}k | +${src.length.toLocaleString()} | ${(ms / 1000).toFixed(1)}s | **${(rate).toFixed(0)} doc/s** (${(rate * 60 / 1000).toFixed(0)}k/min) |`);
    appendFileSync(OUT, JSON.stringify({ round: r + 1, size: total, docsPerSec: Math.round(rate) }) + "\n");
  }
  await c.drop().catch(() => {});
  console.log(`\n(throughput di SCRITTURA del DB su singolo nodo; se ~costante → la dimensione non degrada gli insert)`);
  await closeClient();
}

main().catch((e) => { console.error("✗ bench-ingest-db failed:", e); process.exitCode = 1; }).finally(closeClient);
