// L3 — fuzzy match per Imprese basato su distanza di Levenshtein.
// Per coppie di Impresa diverse (CF distinti) il cui denominazioneNormalizzata
// abbia distanza piccola (≤ 2 caratteri e ≤ 20% della lunghezza minima),
// crea una relazione (a)-[:POSSIBILE_DUPLICATO_DI]->(b).
//
// È un'indicazione, non una decisione: il merge resta a giudizio umano.
//
// Blocking: tre primi caratteri del normalizzato + minLen >= 8 per evitare
// match su generici tipo "comune di" o "istituto".

import { read, write, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

const MAX_EDIT_DISTANCE = Number(process.env.L3_MAX_EDIT ?? 2);
const MAX_REL_DISTANCE = Number(process.env.L3_MAX_REL ?? 0.2);
const MIN_LENGTH = Number(process.env.L3_MIN_LEN ?? 8);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Quick reject if length difference already too big
  if (Math.abs(m - n) > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
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
    if (minRow > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[n];
}

type ImpresaRow = { cf: string; den: string; norm: string; elementId: string };

async function main(): Promise<void> {
  const t0 = Date.now();

  // Recupera tutte le imprese con denominazione abbastanza lunga
  const imprese = await read<ImpresaRow>(
    `MATCH (i:Impresa)
     WHERE i.denominazioneNormalizzata IS NOT NULL
       AND size(i.denominazioneNormalizzata) >= $minLen
     RETURN i.cf AS cf, i.denominazione AS den,
            i.denominazioneNormalizzata AS norm,
            elementId(i) AS elementId`,
    { minLen: MIN_LENGTH },
  );
  console.log(
    `→ L3 fuzzy su ${imprese.length} imprese (min len ${MIN_LENGTH}, max edit ${MAX_EDIT_DISTANCE})`,
  );

  // Indicizza per primi 3 caratteri (blocking key)
  const blocks = new Map<string, ImpresaRow[]>();
  for (const i of imprese) {
    const key = i.norm.slice(0, 3);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key)!.push(i);
  }

  // Recupera coppie già linkate L2 per evitare duplicati
  const l2 = await read<{ a: string; b: string }>(
    `MATCH (a:Impresa)-[:STESSO_SOGGETTO_L2]-(b:Impresa)
     RETURN a.cf AS a, b.cf AS b`,
  );
  const linkedL2 = new Set<string>();
  for (const r of l2) {
    linkedL2.add([r.a, r.b].sort().join("|"));
  }

  const candidates: Array<{
    leftCf: string;
    rightCf: string;
    leftDen: string;
    rightDen: string;
    leftNorm: string;
    rightNorm: string;
    score: number;
    distance: number;
  }> = [];

  let comparisons = 0;
  for (const [, group] of blocks) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        comparisons++;
        const a = group[i];
        const b = group[j];
        if (a.cf === b.cf) continue;
        if (a.norm === b.norm) continue; // already L2 territory
        const key = [a.cf, b.cf].sort().join("|");
        if (linkedL2.has(key)) continue;
        const dist = levenshtein(a.norm, b.norm);
        if (dist > MAX_EDIT_DISTANCE) continue;
        const minLen = Math.min(a.norm.length, b.norm.length);
        if (dist / minLen > MAX_REL_DISTANCE) continue;
        const score = 1 - dist / Math.max(a.norm.length, b.norm.length);
        // Ordine deterministico per leftCf < rightCf → MERGE idempotente
        const [low, high] = a.cf < b.cf ? [a, b] : [b, a];
        candidates.push({
          leftCf: low.cf,
          rightCf: high.cf,
          leftDen: low.den,
          rightDen: high.den,
          leftNorm: low.norm,
          rightNorm: high.norm,
          score,
          distance: dist,
        });
      }
    }
  }
  console.log(
    `  ${comparisons.toLocaleString("it-IT")} confronti, ${candidates.length} candidate`,
  );

  if (candidates.length === 0) {
    console.log(`\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — niente da linkare`);
    return;
  }

  // Crea le relazioni in batch — direzione deterministica (cf alfabetico)
  await write(
    `UNWIND $rows AS row
     MATCH (a:Impresa {cf: row.leftCf}), (b:Impresa {cf: row.rightCf})
     MERGE (a)-[r:POSSIBILE_DUPLICATO_DI]->(b)
       ON CREATE SET r.score = row.score,
                     r.distance = row.distance,
                     r.linkedAt = datetime(),
                     r.rule = "levenshtein"`,
    { rows: candidates },
  );

  // Log su Mongo
  const d = await db();
  await d.collection("linkage_log").insertMany(
    candidates.map((c) => ({
      level: "L3",
      label: "Impresa",
      rule: "levenshtein",
      score: c.score,
      distance: c.distance,
      left: { cf: c.leftCf, denominazione: c.leftDen, norm: c.leftNorm },
      right: { cf: c.rightCf, denominazione: c.rightDen, norm: c.rightNorm },
      createdAt: new Date(),
    })),
  );

  console.log(`  ${candidates.length} relazioni POSSIBILE_DUPLICATO_DI create`);
  console.log("\n  top esempi (per score):");
  for (const c of candidates.sort((a, b) => b.score - a.score).slice(0, 8)) {
    console.log(
      `    score ${c.score.toFixed(3)}  edit ${c.distance}  ${c.leftDen}  ≈  ${c.rightDen}`,
    );
  }
  console.log(`\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("\n✗ linkage-l3 failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
