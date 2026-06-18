// BENCHMARK latenza query al variare del dataset (25/50/75/100%) — Condizione 1.
// Crea sottoinsiemi server-side ($out) di dimensione crescente, indicizzati, e misura
// p50/p95 di query rappresentative: lookup puntuale (CIG), filtro su indice (SA),
// aggregazione (top imprese per importo). Warm-up incluso.
// Uso: npm run bench:query

import { db, closeClient } from "../lib/mongo";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";

const OUT = "../benchmarks/query-scale.jsonl";
const FRACS = [0.25, 0.5, 0.75, 1.0];
const RUNS = Number(process.env.RUNS ?? 60), WARM = 5;
const TMP = "_bench_q";
/* eslint-disable @typescript-eslint/no-explicit-any */
const pctl = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

async function timeIt(fn: () => Promise<unknown>, runs: number) {
  const l: number[] = [];
  for (let i = 0; i < runs + WARM; i++) { const t = performance.now(); await fn(); const d = performance.now() - t; if (i >= WARM) l.push(d); }
  return { p50: pctl(l, 0.5), p95: pctl(l, 0.95) };
}
const fmt = (q: { p50: number; p95: number }) => `${q.p50.toFixed(1)}/${q.p95.toFixed(1)}`;

async function main(): Promise<void> {
  const d = await db();
  const lotti = d.collection("lotti");
  const N = await lotti.estimatedDocumentCount();
  console.log(`→ ${N} lotti totali\n`);

  // campiona CIG e CF reali per le query
  const sample = await lotti.aggregate([{ $sample: { size: 300 } }, { $project: { "stazioneAppaltante.cf": 1, "aggiudicazioni.impresa.cf": 1 } }]).toArray() as any[];
  const cigs = sample.map((x) => x._id);
  const saCfs = [...new Set(sample.map((x) => x.stazioneAppaltante?.cf).filter(Boolean))];
  const rnd = <T>(a: T[]) => a[(Math.random() * a.length) | 0];

  mkdirSync("../benchmarks", { recursive: true });
  rmSync(OUT, { force: true });
  console.log("| % dati | lotti | Q1 lookup CIG | Q2 filtro SA | Q3 aggregazione top-imprese |");
  console.log("|---|---|---|---|---| (p50/p95 ms)");
  for (const frac of FRACS) {
    const k = Math.floor(N * frac);
    await lotti.aggregate([{ $limit: k }, { $out: TMP }]).toArray();
    const b = d.collection(TMP);
    await b.createIndex({ "stazioneAppaltante.cf": 1 });
    await b.createIndex({ "aggiudicazioni.impresa.cf": 1 });

    const q1 = await timeIt(() => b.findOne({ _id: rnd(cigs) as never }), RUNS);
    const q2 = await timeIt(() => b.find({ "stazioneAppaltante.cf": rnd(saCfs) }).toArray(), RUNS);
    const q3 = await timeIt(() => b.aggregate([
      { $unwind: "$aggiudicazioni" },
      { $group: { _id: "$aggiudicazioni.impresa.cf", tot: { $sum: "$aggiudicazioni.importo" }, n: { $sum: 1 } } },
      { $sort: { tot: -1 } }, { $limit: 10 },
    ], { allowDiskUse: true }).toArray(), Math.min(RUNS, 15));

    console.log(`| ${(frac * 100).toFixed(0)}% | ${k.toLocaleString()} | ${fmt(q1)} | ${fmt(q2)} | ${fmt(q3)} |`);
    appendFileSync(OUT, JSON.stringify({
      pct: frac * 100, lotti: k,
      lookupP50: +q1.p50.toFixed(2), lookupP95: +q1.p95.toFixed(2),
      filtroP50: +q2.p50.toFixed(2), filtroP95: +q2.p95.toFixed(2),
      aggP50: +q3.p50.toFixed(1), aggP95: +q3.p95.toFixed(1),
    }) + "\n");
  }
  await d.collection(TMP).drop().catch(() => {});
  console.log("\n(lookup/filtro su indice ~costanti = O(log n); l'aggregazione full-scan cresce col dataset)");
  await closeClient();
}

main().catch((e) => { console.error("✗ bench-query failed:", e); process.exitCode = 1; }).finally(closeClient);
