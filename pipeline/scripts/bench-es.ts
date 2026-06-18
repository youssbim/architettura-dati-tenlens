// BENCHMARK ricerca vettoriale — Elasticsearch (kNN HNSW) vs ground-truth esatto.
// Vettori REALI caricati in Float32Array compatto (no OOM). Misura: tempo di
// indicizzazione, latenza kNN p50/p95, throughput, RECALL@10 (HNSW è approssimato).
//
// Uso: ES_URL=http://localhost:9200 SCALES=25000,50000,75000,99000 npm run bench:es

import { db, closeClient } from "../lib/mongo";

import { appendFileSync, mkdirSync, rmSync } from "node:fs";
const OUT = "../benchmarks/search-es.jsonl";
const ES = process.env.ES_URL ?? "http://localhost:9200";
const INDEX = "lotti_vec";
const SCALES = (process.env.SCALES ?? "25000,50000,75000,99000").split(",").map(Number);
const QUERIES = Number(process.env.QUERIES ?? 30);
const TOPK = Number(process.env.TOPK ?? 10);
const NUM_CAND = Number(process.env.NUM_CANDIDATES ?? 100);
const BULK = Number(process.env.BULK ?? 500);
const DIM_OVERRIDE = Number(process.env.DIM ?? 0) || 0; // troncamento Matryoshka

/* eslint-disable @typescript-eslint/no-explicit-any */
const j = async (method: string, path: string, body?: any, ndjson = false, tries = 6): Promise<any> => {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(ES + path, { method, headers: { "Content-Type": ndjson ? "application/x-ndjson" : "application/json" }, body: ndjson ? body : body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error(`${method} ${path} → 429 (retry esauriti)`);
};
const norm = (v: Float32Array, off: number, dim: number) => { let n = 0; for (let i = 0; i < dim; i++) n += v[off + i] * v[off + i]; n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) v[off + i] /= n; };
const pctl = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

function topKExact(data: Float32Array, qoff: number, N: number, dim: number, k: number): number[] {
  const idx = new Int32Array(k).fill(-1), sc = new Float64Array(k).fill(-2);
  for (let r = 0; r < N; r++) {
    const off = r * dim; let s = 0; for (let i = 0; i < dim; i++) s += data[qoff + i] * data[off + i];
    if (s > sc[k - 1]) { let p = k - 1; while (p > 0 && sc[p - 1] < s) { sc[p] = sc[p - 1]; idx[p] = idx[p - 1]; p--; } sc[p] = s; idx[p] = r; }
  }
  return [...idx];
}

async function main(): Promise<void> {
  const d = await db();
  const L = d.collection("lotti");
  const one = await L.findOne({ embedding: { $exists: true } }, { projection: { embedding: 1 } }) as any;
  const fullDim = one.embedding.length;
  const dim = DIM_OVERRIDE && DIM_OVERRIDE < fullDim ? DIM_OVERRIDE : fullDim; // troncamento Matryoshka
  const have = await L.countDocuments({ embedding: { $exists: true } });
  mkdirSync("../benchmarks", { recursive: true });
  rmSync(OUT, { force: true });
  const maxN = Math.max(...SCALES);
  const need = Math.min(maxN, have);
  console.log(`→ ${have} vettori reali (dim=${dim}), ES=${ES}; carico ${need}…`);
  const data = new Float32Array(maxN * dim);
  let row = 0;
  for await (const l of L.find({ embedding: { $exists: true } }, { projection: { embedding: 1 } }).limit(need) as any) {
    const e = l.embedding as number[], off = row * dim; for (let i = 0; i < dim; i++) data[off + i] = e[i]; norm(data, off, dim); row++;
  }
  for (let r = need; r < maxN; r++) { const s = (r % need) * dim, off = r * dim; for (let i = 0; i < dim; i++) data[off + i] = data[s + i] + (Math.random() - 0.5) * 0.01; norm(data, off, dim); }

  console.log(`\n| N | index time | p50 | p95 | throughput | recall@10 |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const N of SCALES) {
    await j("DELETE", `/${INDEX}`).catch(() => {});
    await j("PUT", `/${INDEX}`, { settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: -1 }, mappings: { properties: { vec: { type: "dense_vector", dims: dim, index: true, similarity: "cosine" } } } });
    const t0 = performance.now();
    for (let s = 0; s < N; s += BULK) {
      let body = "";
      for (let r = s; r < Math.min(s + BULK, N); r++) { const off = r * dim; body += `{"index":{"_id":"${r}"}}\n${JSON.stringify({ vec: Array.from(data.subarray(off, off + dim)) })}\n`; }
      await j("POST", `/${INDEX}/_bulk`, body, true);
    }
    await j("POST", `/${INDEX}/_refresh`);
    const idxTime = ((performance.now() - t0) / 1000).toFixed(1);

    const qIdx = Array.from({ length: QUERIES }, () => (Math.random() * N) | 0);
    const lat: number[] = []; let hit = 0;
    for (const qi of qIdx) {
      const qoff = qi * dim, qv = Array.from(data.subarray(qoff, qoff + dim));
      const t = performance.now();
      const res = await j("POST", `/${INDEX}/_search`, { knn: { field: "vec", query_vector: qv, k: TOPK, num_candidates: NUM_CAND }, _source: false, size: TOPK });
      lat.push(performance.now() - t);
      const got = new Set(res.hits.hits.map((h: any) => Number(h._id)));
      for (const e of topKExact(data, qoff, N, dim, TOPK)) if (got.has(e)) hit++;
    }
    lat.sort((a, b) => a - b);
    const qps = (1000 / (lat.reduce((a, b) => a + b, 0) / lat.length)).toFixed(0);
    const recall = +(hit / (QUERIES * TOPK) * 100).toFixed(1);
    console.log(`| ${N.toLocaleString()} | ${idxTime}s | ${pctl(lat, 0.5).toFixed(1)} ms | ${pctl(lat, 0.95).toFixed(1)} ms | ${qps} q/s | ${recall}% |`);
    appendFileSync(OUT, JSON.stringify({ N, dim, indexSec: +idxTime, p50: +pctl(lat, 0.5).toFixed(1), p95: +pctl(lat, 0.95).toFixed(1), qps: +qps, recall }) + "\n");
  }
  await j("DELETE", `/${INDEX}`).catch(() => {});
  console.log(`\n(kNN HNSW: latenza ~piatta/sublineare al crescere di N, ma approssimata → recall < 100%)`);
  await closeClient();
}

main().catch((e) => { console.error("✗ bench-es failed:", e); process.exitCode = 1; }).finally(closeClient);
