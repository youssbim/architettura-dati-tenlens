// BENCHMARK sharding (Condizione 2) — UNA misura sul cluster già configurato con
// N shard PRE-SPLIT (vedi shard-setup.sh NSHARDS=N). Carica i lotti via mongos
// (distribuiti all'inserimento per hash del CIG, niente migrazione/orfani) e misura
// la latenza di una query scatter-gather (aggregazione, beneficia degli shard) e
// puntuale (per CIG, 1 shard). La curva 1→2→3 la produce il driver bench-shard-curve.sh.
// Uso: LOAD=200000 npm run bench:shard

import { MongoClient } from "mongodb";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const OUT = "../benchmarks/shard-bench.jsonl";

const SRC = "mongodb://localhost:27017";
const MONGOS = "mongodb://localhost:27050";
const SHARD_PORTS = [27041, 27042, 27043, 27044, 27045];
const LOAD = Number(process.env.LOAD ?? 200000);
const RUNS = Number(process.env.RUNS ?? 30), WARM = 5;
const pctl = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };
/* eslint-disable @typescript-eslint/no-explicit-any */
async function timeIt(fn: () => Promise<unknown>, runs: number) {
  const l: number[] = [];
  for (let i = 0; i < runs + WARM; i++) { const t = performance.now(); await fn(); if (i >= WARM) l.push(performance.now() - t); }
  return { p50: pctl(l, 0.5), p95: pctl(l, 0.95) };
}

async function main(): Promise<void> {
  const ns = parseInt(execSync(`docker exec garagraph-shard-mongos-1 mongosh --quiet --port 27017 --eval "print(db.adminCommand({listShards:1}).shards.length)"`).toString().trim()) || 1;

  const src = new MongoClient(SRC); await src.connect();
  const dst = new MongoClient(MONGOS); await dst.connect();
  const dstL = dst.db("bench").collection("lotti");
  await dstL.deleteMany({});

  // ── SCRITTURA: carica i lotti via mongos (distribuiti per hash del CIG) e cronometra
  //    → throughput di scrittura distribuita (doc/s) a N shard. Pre-leggo i doc dalla
  //    sorgente in memoria così il timer misura la SCRITTURA sul cluster, non la lettura src.
  const docs: any[] = [];
  for await (const doc of src.db("garagraph").collection("lotti").find({}, { projection: { embedding: 0, _embedText: 0 } }).limit(LOAD)) docs.push(doc);
  let loaded = 0;
  const tw = performance.now();
  for (let i = 0; i < docs.length; i += 3000) {
    await dstL.insertMany(docs.slice(i, i + 3000), { ordered: false });
    loaded += Math.min(3000, docs.length - i);
  }
  const writeMs = performance.now() - tw;
  const writeDocsPerSec = loaded / (writeMs / 1000);

  // distribuzione: doc per shard (conteggio diretto — accurato, niente migrazione → niente orfani)
  const dist: number[] = [];
  for (let s = 1; s <= ns; s++) {
    const c = new MongoClient(`mongodb://localhost:${SHARD_PORTS[s - 1]}/?directConnection=true`);
    await c.connect(); dist.push(await c.db("bench").collection("lotti").estimatedDocumentCount()); await c.close();
  }

  const sample = await dstL.aggregate([{ $sample: { size: 200 } }, { $project: { _id: 1 } }]).toArray() as any[];
  const cigs = sample.map((x) => x._id);
  const rnd = <T>(a: T[]) => a[(Math.random() * a.length) | 0];
  const agg = await timeIt(() => dstL.aggregate([{ $unwind: "$aggiudicazioni" }, { $group: { _id: "$aggiudicazioni.impresa.cf", tot: { $sum: "$aggiudicazioni.importo" } } }, { $sort: { tot: -1 } }, { $limit: 10 }]).toArray(), 20);
  const point = await timeIt(() => dstL.findOne({ _id: rnd(cigs) as never }), RUNS);

  const distS = dist.map((n, i) => `s${i + 1}:${(n / 1000).toFixed(0)}k`).join(" ");
  console.log(`| ${ns} | ${loaded.toLocaleString()} | ${distS} | ${(writeDocsPerSec / 1000).toFixed(1)}k doc/s | ${agg.p50.toFixed(0)}/${agg.p95.toFixed(0)} ms | ${point.p50.toFixed(2)}/${point.p95.toFixed(2)} ms |`);

  // riga JSON per i grafici del report
  mkdirSync("../benchmarks", { recursive: true });
  appendFileSync(OUT, JSON.stringify({
    shards: ns, loaded, dist,
    writeDocsPerSec: Math.round(writeDocsPerSec), writeMs: Math.round(writeMs),
    aggP50: +agg.p50.toFixed(1), aggP95: +agg.p95.toFixed(1),
    pointP50: +point.p50.toFixed(2), pointP95: +point.p95.toFixed(2),
  }) + "\n");
  await src.close(); await dst.close();
}

main().catch((e) => { console.error("✗ bench-shard failed:", e.message); process.exitCode = 1; });
