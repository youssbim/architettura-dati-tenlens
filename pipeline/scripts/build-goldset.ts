// Generatore di candidati per il GOLD SET di record linkage.
//
// Carica le :Impresa da Neo4j e campiona coppie candidate stratificate per
// banda di difficoltà (distanza di edit sul denominazioneNormalizzata), così
// il gold set copre l'intero spettro decisionale e non solo i casi facili:
//
//   EXACT  norm identico, CF diverso        → ciò che L2 flagga  (precision L2)
//   NEAR   edit 1-2, ≤20% di minLen         → ciò che L3 flagga  (precision L3)
//   MID    edit 3-6                         → né L2 né L3         (recall: dup persi?)
//   FAR    prefisso diverso, coppia random  → negativi facili     (controllo)
//
// Output: scripts/data/goldset.csv con colonna `label` VUOTA, da annotare a
// mano (same | diff). systemPrediction replica la regola reale di L2/L3, così
// poi precision/recall si calcolano confrontando label umana vs predizione.
//
// Riproducibile: campionamento seedato (GOLD_SEED, default 42).
//
// Uso:
//   npm run goldset:build
//   GOLD_SEED=7 EXACT_N=12 NEAR_N=14 MID_N=14 FAR_N=8 npm run goldset:build

import { read, closeDriver } from "../lib/neo4j";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SEED = Number(process.env.GOLD_SEED ?? 42);
const EXACT_N = Number(process.env.EXACT_N ?? 12);
const NEAR_N = Number(process.env.NEAR_N ?? 14);
const MID_N = Number(process.env.MID_N ?? 14);
const FAR_N = Number(process.env.FAR_N ?? 8);

const MIN_LEN = 8; // mirror di L3_MIN_LEN: sotto questa soglia il fuzzy è rumore
const NEAR_MAX_EDIT = 2;
const NEAR_MAX_REL = 0.2;
const MID_MIN_EDIT = 3;
const MID_MAX_EDIT = 6;
const BLOCK_CAP = 400; // campiona i blocchi troppo grandi per restare veloci
const PER_BLOCK = Number(process.env.PER_BLOCK ?? 2); // diversità: max coppie per prefisso

const OUT = process.env.GOLD_CSV
  ? path.resolve(process.env.GOLD_CSV)
  : path.join(process.cwd(), "scripts", "data", "goldset.csv");

// ---- RNG seedato (mulberry32) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Levenshtein con early-exit oltre maxDist ----
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) return maxDist + 1;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let curr: number[] = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let minRow = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minRow) minRow = curr[j];
    }
    if (minRow > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

type Imp = { cf: string; den: string; norm: string };
type Cand = {
  band: "EXACT" | "NEAR" | "MID" | "FAR";
  left: Imp;
  right: Imp;
  dist: number;
  rel: number;
};

function systemPrediction(c: Cand): "L2" | "L3" | "none" {
  if (c.left.norm === c.right.norm) return "L2";
  const minLen = Math.min(c.left.norm.length, c.right.norm.length);
  if (c.dist >= 1 && c.dist <= NEAR_MAX_EDIT && c.dist / minLen <= NEAR_MAX_REL && minLen >= MIN_LEN)
    return "L3";
  return "none";
}

function csvCell(s: string | number): string {
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`→ carico le :Impresa (seed=${SEED})...`);
  const imprese = await read<Imp>(
    `MATCH (i:Impresa)
     WHERE i.denominazioneNormalizzata IS NOT NULL
       AND i.cf IS NOT NULL
     RETURN i.cf AS cf, i.denominazione AS den,
            i.denominazioneNormalizzata AS norm`,
  );
  console.log(`  ${imprese.length.toLocaleString("it-IT")} imprese`);

  // ---------- EXACT: stesso norm, CF diverso ----------
  const byNorm = new Map<string, Imp[]>();
  for (const i of imprese) {
    if (!i.norm || i.norm.length < MIN_LEN) continue;
    if (!byNorm.has(i.norm)) byNorm.set(i.norm, []);
    byNorm.get(i.norm)!.push(i);
  }
  const exactPairs: Cand[] = [];
  for (const [, group] of byNorm) {
    const cfs = new Map<string, Imp>();
    for (const i of group) if (!cfs.has(i.cf)) cfs.set(i.cf, i);
    const distinct = [...cfs.values()];
    if (distinct.length < 2) continue;
    // una coppia rappresentativa per gruppo (i primi due CF distinti)
    exactPairs.push({ band: "EXACT", left: distinct[0], right: distinct[1], dist: 0, rel: 0 });
  }

  // ---------- NEAR / MID: blocking sui primi 3 caratteri ----------
  const blocks = new Map<string, Imp[]>();
  for (const i of imprese) {
    if (!i.norm || i.norm.length < MIN_LEN) continue;
    const key = i.norm.slice(0, 3);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key)!.push(i);
  }
  const near: Cand[] = [];
  const mid: Cand[] = [];
  const blockKeys = shuffle([...blocks.keys()]);
  for (const key of blockKeys) {
    if (near.length >= NEAR_N * 3 && mid.length >= MID_N * 3) break;
    let group = blocks.get(key)!;
    if (group.length < 2) continue;
    if (group.length > BLOCK_CAP) group = shuffle(group).slice(0, BLOCK_CAP);
    // diversità: al massimo PER_BLOCK coppie per prefisso, per non far dominare
    // blocchi enormi (es. "di " dei cognomi meridionali)
    let nearHere = 0;
    let midHere = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (nearHere >= PER_BLOCK && midHere >= PER_BLOCK) break;
        const a = group[i];
        const b = group[j];
        if (a.cf === b.cf || a.norm === b.norm) continue;
        const dist = levenshtein(a.norm, b.norm, MID_MAX_EDIT);
        if (dist > MID_MAX_EDIT) continue;
        const minLen = Math.min(a.norm.length, b.norm.length);
        const rel = dist / minLen;
        const cand: Cand = { band: "NEAR", left: a, right: b, dist, rel };
        if (dist <= NEAR_MAX_EDIT && rel <= NEAR_MAX_REL) {
          if (near.length < NEAR_N * 3 && nearHere < PER_BLOCK) { near.push({ ...cand, band: "NEAR" }); nearHere++; }
        } else if (dist >= MID_MIN_EDIT) {
          if (mid.length < MID_N * 3 && midHere < PER_BLOCK) { mid.push({ ...cand, band: "MID" }); midHere++; }
        }
      }
    }
  }

  // ---------- FAR: coppie random a prefisso diverso ----------
  const far: Cand[] = [];
  const pool = imprese.filter((i) => i.norm && i.norm.length >= MIN_LEN);
  let guard = 0;
  while (far.length < FAR_N && guard < FAR_N * 50) {
    guard++;
    const a = pool[Math.floor(rnd() * pool.length)];
    const b = pool[Math.floor(rnd() * pool.length)];
    if (a.cf === b.cf) continue;
    if (a.norm.slice(0, 3) === b.norm.slice(0, 3)) continue;
    const dist = levenshtein(a.norm, b.norm, 999);
    far.push({ band: "FAR", left: a, right: b, dist, rel: dist / Math.min(a.norm.length, b.norm.length) });
  }

  // ---------- campiona le quote ----------
  const picked: Cand[] = [
    ...shuffle(exactPairs).slice(0, EXACT_N),
    ...shuffle(near).slice(0, NEAR_N),
    ...shuffle(mid).slice(0, MID_N),
    ...far.slice(0, FAR_N),
  ];

  // ---------- scrivi CSV ----------
  const header = [
    "id", "band", "editDistance", "relDistance", "systemPrediction",
    "leftCf", "leftDen", "rightCf", "rightDen", "leftNorm", "rightNorm",
    "label", "note",
  ];
  const lines = [header.join(",")];
  picked.forEach((c, idx) => {
    lines.push(
      [
        idx + 1,
        c.band,
        c.dist,
        c.rel.toFixed(3),
        systemPrediction(c),
        c.left.cf,
        c.left.den,
        c.right.cf,
        c.right.den,
        c.left.norm,
        c.right.norm,
        "", // label: da annotare a mano (same|diff)
        "", // note
      ]
        .map(csvCell)
        .join(","),
    );
  });
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, lines.join("\n") + "\n", "utf8");

  // ---------- riepilogo + stampa per revisione ----------
  const counts = picked.reduce<Record<string, number>>((m, c) => {
    m[c.band] = (m[c.band] ?? 0) + 1;
    return m;
  }, {});
  console.log(
    `\n✓ ${picked.length} candidati → ${path.relative(process.cwd(), OUT)}` +
      `  (EXACT ${counts.EXACT ?? 0} · NEAR ${counts.NEAR ?? 0} · MID ${counts.MID ?? 0} · FAR ${counts.FAR ?? 0})`,
  );
  console.log(`  pool EXACT=${exactPairs.length} NEAR=${near.length} MID=${mid.length} (prima del campionamento)\n`);

  for (const band of ["EXACT", "NEAR", "MID", "FAR"] as const) {
    const rows = picked.filter((c) => c.band === band);
    if (rows.length === 0) continue;
    console.log(`== ${band} ==`);
    rows.forEach((c) => {
      const pred = systemPrediction(c);
      console.log(
        `  [edit ${c.dist} rel ${c.rel.toFixed(2)} pred=${pred}]  ` +
          `${c.left.den}  ⟷  ${c.right.den}`,
      );
    });
    console.log();
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("\n✗ build-goldset failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
  });
