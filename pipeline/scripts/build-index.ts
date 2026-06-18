// ⑤ INDICE SOGGETTI + ENTITY RESOLUTION (tutto in MongoDB, prima del grafo).
//   1. estrae i soggetti distinti (per CF) dai `lotti` → collezione `soggetti`
//   2. blocking + linkVerdict + union-find → cluster di entità
//   3. scrive la tabella `entita` (golden record) + `entityId` su ogni soggetto
// Le coppie incerte (review) finiscono in `linkage_review`.
// Validabile sul campione PRIMA di creare il grafo.
//
// Uso: npm run build:index

import { db, closeClient } from "../lib/mongo";
import { normalizeDenominazione } from "../lib/transform";
import { linkVerdict, editDistance, isValidPIVA } from "../lib/cf";
import type { CanonicalLotto } from "../lib/model";

type Sogg = { _id: string; cf: string; denominazione: string; denominazioneNormalizzata: string; ruoli: string[]; blockingKey: string; entityId?: string };

const MIN_LEN = 8, MAX_EDIT = 2, MAX_REL = 0.2, BLOCK_CAP = 800;

// union-find
const parent = new Map<string, string>();
function find(x: string): string {
  if (!parent.has(x)) parent.set(x, x);
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r)!;
  while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
  return r;
}
function union(a: string, b: string) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const lotti = d.collection<CanonicalLotto>("lotti");
  const soggColl = d.collection<Sogg>("soggetti");
  const entColl = d.collection("entita");
  const revColl = d.collection("linkage_review");

  // ---- 1. estrai soggetti distinti per CF dai lotti ----
  const map = new Map<string, Sogg>();
  const add = (cf: string, den: string, ruolo: string) => {
    if (!cf) return;
    let s = map.get(cf);
    if (!s) { const dn = normalizeDenominazione(den); s = { _id: cf, cf, denominazione: den, denominazioneNormalizzata: dn, ruoli: [], blockingKey: dn.slice(0, 3) }; map.set(cf, s); }
    if (den && (!s.denominazione || den.length > s.denominazione.length)) { s.denominazione = den; s.denominazioneNormalizzata = normalizeDenominazione(den); s.blockingKey = s.denominazioneNormalizzata.slice(0, 3); }
    if (!s.ruoli.includes(ruolo)) s.ruoli.push(ruolo);
  };
  const LIMIT = Number(process.env.LIMIT ?? 0) || 0; // 0 = tutti (per test su sottoinsieme)
  const proj = { projection: { stazioneAppaltante: 1, aggiudicazioni: 1 } }; // NIENTE embedding (evita OOM)
  for await (const l of (LIMIT ? lotti.find({}, proj).limit(LIMIT) : lotti.find({}, proj))) {
    if (l.stazioneAppaltante?.cf) add(l.stazioneAppaltante.cf, l.stazioneAppaltante.denominazione, "buyer");
    for (const a of l.aggiudicazioni ?? []) add(a.impresa.cf, a.impresa.denominazione, "supplier");
  }
  const soggetti = [...map.values()];
  console.log(`→ ${soggetti.length} soggetti distinti (per CF) estratti dai lotti`);

  // ---- 2. blocking + linkVerdict + union-find ----
  const blocks = new Map<string, Sogg[]>();
  for (const s of soggetti) { if (!blocks.has(s.blockingKey)) blocks.set(s.blockingKey, []); blocks.get(s.blockingKey)!.push(s); }
  let merges = 0; const reviews: any[] = []; let comparisons = 0;
  for (const [, group] of blocks) {
    const g = group.length > BLOCK_CAP ? group.slice(0, BLOCK_CAP) : group;
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      const an = a.denominazioneNormalizzata, bn = b.denominazioneNormalizzata;
      // candidato L2 (esatto) o L3 (fuzzy)
      let cand = an === bn && an.length > 0;
      if (!cand && an.length >= MIN_LEN && bn.length >= MIN_LEN && Math.abs(an.length - bn.length) <= MAX_EDIT) {
        const dist = editDistance(an, bn);
        cand = dist >= 1 && dist <= MAX_EDIT && dist / Math.min(an.length, bn.length) <= MAX_REL;
      }
      if (!cand) continue;
      comparisons++;
      const v = linkVerdict(a.cf, b.cf, an, bn);
      if (v.tier === "merge" || v.tier === "bridge") { union(a.cf, b.cf); merges++; }
      else if (v.tier === "review") reviews.push({ a: a.cf, aDen: a.denominazione, b: b.cf, bDen: b.denominazione, reason: v.reason, createdAt: new Date() });
    }
  }

  // ---- 3. cluster → entita + entityId ----
  const clusters = new Map<string, string[]>();
  for (const s of soggetti) { const r = find(s.cf); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r)!.push(s.cf); }
  const byCf = new Map(soggetti.map((s) => [s.cf, s]));
  const entitaDocs: any[] = [];
  for (const [, members] of clusters) {
    // rappresentante: una P.IVA valida, altrimenti il CF minore
    const rep = members.find((cf) => isValidPIVA(cf)) ?? [...members].sort()[0];
    const repS = byCf.get(rep)!;
    const ruoli = [...new Set(members.flatMap((cf) => byCf.get(cf)!.ruoli))];
    const entityId = "ent:" + rep;
    for (const cf of members) byCf.get(cf)!.entityId = entityId;
    entitaDocs.push({ _id: entityId, entityId, cfRappresentante: rep, denominazioneCanonica: repS.denominazione, denominazioneNormalizzata: repS.denominazioneNormalizzata, membriCf: members, nMembri: members.length, ruoli });
  }

  // ---- scrivi su Mongo ----
  await soggColl.deleteMany({}); await entColl.deleteMany({}); await revColl.deleteMany({});
  await soggColl.insertMany(soggetti as never);
  await soggColl.createIndex({ blockingKey: 1 }); await soggColl.createIndex({ entityId: 1 }); await soggColl.createIndex({ denominazioneNormalizzata: 1 });
  await entColl.insertMany(entitaDocs as never);
  if (reviews.length) await revColl.insertMany(reviews as never);

  // ---- validazione ----
  const multi = entitaDocs.filter((e) => e.nMembri > 1);
  console.log(`\n== RISULTATO (campione) ==`);
  console.log(`  soggetti (CF distinti):   ${soggetti.length}`);
  console.log(`  entità (dopo resolution): ${entitaDocs.length}  → ${soggetti.length - entitaDocs.length} CF assorbiti`);
  console.log(`  confronti (post-blocking):${comparisons}   (vs ${soggetti.length * (soggetti.length - 1) / 2} senza blocking)`);
  console.log(`  merge (STESSO_SOGGETTO):  ${merges}`);
  console.log(`  review (POSSIBILE_DUP):   ${reviews.length}`);
  console.log(`\n== entità multi-CF (unite dal linkage) — ${multi.length} ==`);
  for (const e of multi.slice(0, 12)) {
    console.log(`  [${e.entityId}] ${e.denominazioneCanonica}`);
    for (const cf of e.membriCf) console.log(`       ${cf}  ${byCf.get(cf)!.denominazione}`);
  }
  if (reviews.length) { console.log(`\n== review (da confermare a mano) ==`); for (const r of reviews.slice(0, 8)) console.log(`  ${r.aDen} (${r.a}) ⟷ ${r.bDen} (${r.b})`); }
  console.log(`\n✓ build-index done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("\n✗ build-index failed:", e); process.exitCode = 1; }).finally(closeClient);
