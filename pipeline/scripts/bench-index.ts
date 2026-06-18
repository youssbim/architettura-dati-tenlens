// BENCHMARK indice SÌ vs NO — dimostra il valore dell'indice (richiamo del prof:
// "costruisciti un indice… che poi ti servirà"). Per due ricerche reali di società,
// misura la latenza CON l'indice (O(log n)) e SENZA (collection scan O(n)), poi
// RIPRISTINA l'indice. Niente collezioni temporanee: gira sui dati reali.
// Uso: npm run bench:index

import { db, closeClient } from "../lib/mongo";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";

const OUT = "../benchmarks/index-onoff.jsonl";
const RUNS = Number(process.env.RUNS ?? 25), WARM = 3;
/* eslint-disable @typescript-eslint/no-explicit-any */
const pctl = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

async function timeIt(fn: () => Promise<unknown>, runs: number) {
  const l: number[] = [];
  for (let i = 0; i < runs + WARM; i++) { const t = performance.now(); await fn(); if (i >= WARM) l.push(performance.now() - t); }
  return { p50: pctl(l, 0.5), p95: pctl(l, 0.95) };
}

async function main(): Promise<void> {
  const d = await db();
  mkdirSync("../benchmarks", { recursive: true });
  rmSync(OUT, { force: true });

  const lotti = d.collection("lotti");
  const sogg = d.collection("soggetti");
  const nL = await lotti.estimatedDocumentCount();
  const nS = await sogg.estimatedDocumentCount();
  console.log(`→ lotti=${nL.toLocaleString()} · soggetti=${nS.toLocaleString()}\n`);

  // valori reali campionati
  const sCf = (await lotti.aggregate([{ $sample: { size: 200 } }, { $unwind: "$aggiudicazioni" }, { $project: { cf: "$aggiudicazioni.impresa.cf" } }]).toArray() as any[]).map((x) => x.cf).filter(Boolean);
  const sNames = (await sogg.aggregate([{ $sample: { size: 200 } }, { $project: { dn: "$denominazioneNormalizzata" } }]).toArray() as any[]).map((x) => x.dn).filter(Boolean);
  const rnd = <T>(a: T[]) => a[(Math.random() * a.length) | 0];

  const scenarios = [
    { key: "lotti_by_impresa", label: "Trova le gare di un'azienda (lotti.aggiudicazioni.impresa.cf)", coll: lotti,
      index: { spec: { "aggiudicazioni.impresa.cf": 1 } as any, name: "by_impresa" },
      query: () => lotti.find({ "aggiudicazioni.impresa.cf": rnd(sCf) }).toArray() },
    { key: "soggetti_by_nome", label: "Cerca azienda per nome (soggetti.denominazioneNormalizzata)", coll: sogg,
      index: { spec: { denominazioneNormalizzata: 1 } as any, name: "den_norm" },
      query: () => sogg.find({ denominazioneNormalizzata: rnd(sNames) }).toArray() },
  ];

  console.log("| ricerca | CON indice p50/p95 | SENZA indice (scan) p50/p95 | speedup |");
  console.log("|---|---|---|---|");
  for (const sc of scenarios) {
    // assicura indice presente
    await sc.coll.createIndex(sc.index.spec, { name: sc.index.name }).catch(() => {});
    const withIdx = await timeIt(sc.query, RUNS);
    // togli l'indice → collection scan
    await sc.coll.dropIndex(sc.index.name).catch(async () => {
      // l'indice potrebbe avere un nome auto-generato: trovalo e droppalo
      const idxs = await sc.coll.indexes();
      const k = Object.keys(sc.index.spec)[0];
      const found = idxs.find((i: any) => i.key && Object.keys(i.key)[0] === k && i.name !== "_id_");
      if (found) await sc.coll.dropIndex(found.name);
    });
    const noIdx = await timeIt(sc.query, Math.min(RUNS, 12));
    // RIPRISTINA l'indice
    await sc.coll.createIndex(sc.index.spec, { name: sc.index.name });

    const speedup = noIdx.p50 / (withIdx.p50 || 1);
    console.log(`| ${sc.label.split("(")[0].trim()} | ${withIdx.p50.toFixed(2)}/${withIdx.p95.toFixed(2)} ms | ${noIdx.p50.toFixed(0)}/${noIdx.p95.toFixed(0)} ms | **${speedup.toFixed(0)}×** |`);
    appendFileSync(OUT, JSON.stringify({
      key: sc.key, label: sc.label,
      withP50: +withIdx.p50.toFixed(2), withP95: +withIdx.p95.toFixed(2),
      noP50: +noIdx.p50.toFixed(1), noP95: +noIdx.p95.toFixed(1),
      speedup: +speedup.toFixed(1),
    }) + "\n");
  }
  console.log("\n(CON indice = O(log n), sub-ms; SENZA = collection scan O(n) → cresce col dataset. Indici ripristinati.)");
  await closeClient();
}

main().catch((e) => { console.error("✗ bench-index failed:", e); process.exitCode = 1; }).finally(closeClient);
