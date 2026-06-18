// Quanti gold set "indipendenti" possiamo davvero generare?
// La risposta non dipende dai seed ma dal POOL di coppie candidate distinte,
// e in particolare dai POSITIVI (duplicati veri), che sono la risorsa scarsa.
//
// Questo script NON campiona: enumera l'intera popolazione della banda EXACT
// (stesso nome normalizzato, CF diverso) e la classifica con linkVerdict, più
// un grande campione della banda NEAR (fuzzy edit 1-2). Così otteniamo il
// soffitto reale e la stima di falsi merge del L2 attuale sull'intero grafo.
//
// Uso: npm run goldset:ceiling

import { read, closeDriver } from "../lib/neo4j";
import { linkVerdict, classifyCf, editDistance, type LinkTier } from "../lib/cf";

const MIN_LEN = 8;
const GROUP_CAP = 25; // limita C(k,2) sui nomi con tantissimi CF
const NEAR_SAMPLE_CAP = 40000;

type Imp = { cf: string; norm: string };

function tally() {
  return { merge: 0, bridge: 0, review: 0, reject: 0 } as Record<LinkTier, number>;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const imprese = await read<Imp>(
    `MATCH (i:Impresa)
     WHERE i.denominazioneNormalizzata IS NOT NULL AND i.cf IS NOT NULL
       AND size(i.denominazioneNormalizzata) >= $minLen
     RETURN i.cf AS cf, i.denominazioneNormalizzata AS norm`,
    { minLen: MIN_LEN },
  );
  console.log(`Imprese (norm ≥ ${MIN_LEN}): ${imprese.length.toLocaleString("it-IT")}\n`);

  // ---------- EXACT: popolazione INTERA ----------
  const byNorm = new Map<string, Set<string>>();
  for (const i of imprese) {
    if (!byNorm.has(i.norm)) byNorm.set(i.norm, new Set());
    byNorm.get(i.norm)!.add(i.cf);
  }
  const exactTiers = tally();
  let exactGroups = 0;
  let exactPairs = 0;
  let capped = 0;
  let omonymClusters = 0; // gruppi con ≥2 P.IVA valide distinte (= falsi merge del L2)
  for (const [norm, cfSet] of byNorm) {
    let cfs = [...cfSet];
    if (cfs.length < 2) continue;
    exactGroups++;
    const nValidPiva = cfs.filter((c) => {
      const cl = classifyCf(c);
      return cl.kind === "PIVA" && cl.valid;
    }).length;
    if (nValidPiva >= 2) omonymClusters++;
    if (cfs.length > GROUP_CAP) { capped++; cfs = cfs.slice(0, GROUP_CAP); }
    for (let i = 0; i < cfs.length; i++) {
      for (let j = i + 1; j < cfs.length; j++) {
        exactPairs++;
        exactTiers[linkVerdict(cfs[i], cfs[j], norm, norm).tier]++;
      }
    }
  }

  // ---------- NEAR: grande campione (fuzzy edit 1-2) ----------
  const blocks = new Map<string, Imp[]>();
  for (const i of imprese) {
    const k = i.norm.slice(0, 3);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(i);
  }
  const nearTiers = tally();
  let nearPairs = 0;
  outer: for (const [, group] of blocks) {
    if (group.length < 2) continue;
    const g = group.length > 600 ? group.slice(0, 600) : group;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i];
        const b = g[j];
        if (a.cf === b.cf || a.norm === b.norm) continue;
        if (Math.abs(a.norm.length - b.norm.length) > 2) continue;
        const d = editDistance(a.norm, b.norm);
        if (d < 1 || d > 2) continue;
        if (d / Math.min(a.norm.length, b.norm.length) > 0.2) continue;
        nearPairs++;
        nearTiers[linkVerdict(a.cf, b.cf, a.norm, b.norm).tier]++;
        if (nearPairs >= NEAR_SAMPLE_CAP) break outer;
      }
    }
  }

  const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");
  console.log("== banda EXACT — POPOLAZIONE INTERA ==");
  console.log(`  gruppi (stesso nome, ≥2 CF distinti): ${exactGroups.toLocaleString("it-IT")}`);
  console.log(`  coppie candidate totali:              ${exactPairs.toLocaleString("it-IT")}${capped ? `  (${capped} gruppi enormi troncati a ${GROUP_CAP} CF)` : ""}`);
  console.log(`    merge  (refuso/identico)   ${String(exactTiers.merge).padStart(6)}  ${pct(exactTiers.merge, exactPairs)}`);
  console.log(`    bridge (CF persona↔P.IVA)  ${String(exactTiers.bridge).padStart(6)}  ${pct(exactTiers.bridge, exactPairs)}`);
  console.log(`    review (incerto → umano)   ${String(exactTiers.review).padStart(6)}  ${pct(exactTiers.review, exactPairs)}`);
  console.log(`    reject (enti distinti!)    ${String(exactTiers.reject).padStart(6)}  ${pct(exactTiers.reject, exactPairs)}`);
  const exactPos = exactTiers.merge + exactTiers.bridge;
  console.log(`  → positivi veri disponibili (merge+bridge): ${exactPos.toLocaleString("it-IT")}`);
  console.log(`  → cluster di OMONIMI (≥2 P.IVA valide): ${omonymClusters.toLocaleString("it-IT")}  ← falsi merge che L2 attuale crea\n`);

  console.log(`== banda NEAR — campione (fuzzy edit 1-2, cap ${NEAR_SAMPLE_CAP.toLocaleString("it-IT")}) ==`);
  console.log(`  coppie candidate:            ${nearPairs.toLocaleString("it-IT")}`);
  console.log(`    merge   ${String(nearTiers.merge).padStart(6)}  ${pct(nearTiers.merge, nearPairs)}`);
  console.log(`    bridge  ${String(nearTiers.bridge).padStart(6)}  ${pct(nearTiers.bridge, nearPairs)}`);
  console.log(`    review  ${String(nearTiers.review).padStart(6)}  ${pct(nearTiers.review, nearPairs)}`);
  console.log(`    reject  ${String(nearTiers.reject).padStart(6)}  ${pct(nearTiers.reject, nearPairs)}`);
  const nearPos = nearTiers.merge + nearTiers.bridge;
  console.log(`  → positivi veri (merge+bridge): ${nearPos.toLocaleString("it-IT")}  (su ${nearPairs} candidati: precision attuale L3 ≈ ${pct(nearPos, nearPairs)})`);

  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("✗ goldset-ceiling failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
  });
