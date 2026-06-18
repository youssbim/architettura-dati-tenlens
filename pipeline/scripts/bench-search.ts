// BENCHMARK ricerca vettoriale — MongoDB brute-force (cosine in-app), vettori REALI.
// Carica gli embedding direttamente in un Float32Array compatto (no toArray →
// niente OOM) e misura latenza/throughput kNN per N crescente (25/50/75/100k…).
// Oltre i vettori reali disponibili, replica con micro-rumore (solo per la latenza).
//
// Uso: SCALES=25000,50000,75000,99000 QUERIES=30 npm run bench:search

import { db, closeClient } from "../lib/mongo";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";

const OUT = "../benchmarks/search-mongo.jsonl";
const SCALES = (process.env.SCALES ?? "25000,50000,75000,99000").split(",").map(Number);
const QUERIES = Number(process.env.QUERIES ?? 30);
const TOPK = Number(process.env.TOPK ?? 10);
const DIM_OVERRIDE = Number(process.env.DIM ?? 0) || 0; // tronca i vettori (Matryoshka) per risparmiare RAM

function norm(v: Float32Array, off: number, dim: number) {
  let n = 0; for (let i = 0; i < dim; i++) n += v[off + i] * v[off + i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) v[off + i] /= n;
}

async function main(): Promise<void> {
  const d = await db();
  const L = d.collection("lotti");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const one = await L.findOne({ embedding: { $exists: true } }, { projection: { embedding: 1 } }) as any;
  const fullDim = one.embedding.length;
  const dim = DIM_OVERRIDE && DIM_OVERRIDE < fullDim ? DIM_OVERRIDE : fullDim; // troncamento Matryoshka
  const have = await L.countDocuments({ embedding: { $exists: true } });
  mkdirSync("../benchmarks", { recursive: true });
  rmSync(OUT, { force: true });
  const maxN = Math.max(...SCALES);
  const need = Math.min(maxN, have);
  console.log(`→ ${have} vettori reali (dim=${dim}); carico ${need} in Float32Array…`);

  const data = new Float32Array(maxN * dim);
  let row = 0;
  for await (const l of L.find({ embedding: { $exists: true } }, { projection: { embedding: 1 } }).limit(need) as any) {
    const e = l.embedding as number[], off = row * dim;
    for (let i = 0; i < dim; i++) data[off + i] = e[i];
    norm(data, off, dim); row++;
  }
  for (let r = need; r < maxN; r++) { const s = (r % need) * dim, off = r * dim; for (let i = 0; i < dim; i++) data[off + i] = data[s + i] + (Math.random() - 0.5) * 0.01; norm(data, off, dim); }

  console.log(`\n| N (vettori) | reali/sintetici | latenza p50 | p95 | throughput |`);
  console.log(`|---|---|---|---|---|`);
  for (const N of SCALES) {
    const qIdx = Array.from({ length: QUERIES }, () => (Math.random() * N) | 0);
    const lat: number[] = [];
    for (const qi of qIdx) {
      const t = performance.now(); const qoff = qi * dim;
      const top = new Float64Array(TOPK).fill(-2);
      for (let r = 0; r < N; r++) {
        const off = r * dim; let s = 0;
        for (let i = 0; i < dim; i++) s += data[qoff + i] * data[off + i];
        if (s > top[TOPK - 1]) { let p = TOPK - 1; while (p > 0 && top[p - 1] < s) { top[p] = top[p - 1]; p--; } top[p] = s; }
      }
      lat.push(performance.now() - t);
    }
    lat.sort((a, b) => a - b);
    const p50 = lat[(lat.length * 0.5) | 0], p95 = lat[(lat.length * 0.95) | 0];
    const qps = (1000 / (lat.reduce((a, b) => a + b, 0) / lat.length)).toFixed(0);
    const kind = N <= have ? "reali" : `${have} reali + ${N - have} sint.`;
    console.log(`| ${N.toLocaleString()} | ${kind} | ${p50.toFixed(1)} ms | ${p95.toFixed(1)} ms | ${qps} q/s |`);
    appendFileSync(OUT, JSON.stringify({ N, dim, p50: +p50.toFixed(1), p95: +p95.toFixed(1), qps: +qps }) + "\n");
  }
  console.log(`\n(brute-force in-app: O(N·dim) per query, esatto → latenza lineare in N)`);
  await closeClient();
}

main().catch((e) => { console.error("✗ bench-search failed:", e); process.exitCode = 1; }).finally(closeClient);
