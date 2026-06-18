// LINKAGE INCREMENTALE / DAILY — processa SOLO i soggetti del delta contro
// l'indice `soggetti`/`entita` esistente (blocking via Mongo, non rebuild totale).
// Per ogni soggetto nuovo/cambiato: blocco → linkVerdict → uno di 3 casi:
//   (a) nessun match      → nuovo entityId
//   (b) match con 1 cluster → eredita quell'entityId
//   (c) collega N cluster  → ENTITY-MERGE (sopravvive 1 entityId, ri-punta i membri)
// Vedi docs/linkage.md §5.
//
// Uso:
//   npm run linkage:incr                 # delta dall'ultimo run (per _updatedAt)
//   SINCE=2026-05-25 npm run linkage:incr
//   CFS=06188330150,6188330150 npm run linkage:incr   # CF specifici (test)
//   FULL=1 LIMIT=50000 npm run linkage:incr            # da indice vuoto su N lotti (validazione)

import { db, closeClient } from "../lib/mongo";
import { normalizeDenominazione } from "../lib/transform";
import { linkVerdict, editDistance, isValidPIVA } from "../lib/cf";
import type { CanonicalLotto } from "../lib/model";

const MIN_LEN = 8, MAX_EDIT = 2, MAX_REL = 0.2;
function isCandidate(an: string, bn: string): boolean {
  if (an === bn && an.length > 0) return true;
  if (an.length >= MIN_LEN && bn.length >= MIN_LEN && Math.abs(an.length - bn.length) <= MAX_EDIT) {
    const dst = editDistance(an, bn);
    return dst >= 1 && dst <= MAX_EDIT && dst / Math.min(an.length, bn.length) <= MAX_REL;
  }
  return false;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  const d = await db();
  const lotti = d.collection<CanonicalLotto>("lotti");
  const S = d.collection("soggetti");
  const E = d.collection("entita");
  const runs = d.collection("linkage_runs");
  const LIMIT = Number(process.env.LIMIT ?? 0) || 0;

  // 1) ambito del delta
  let filter: any = {};
  const cfsEnv = process.env.CFS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.FULL) filter = {};
  else if (process.env.SINCE) filter = { _updatedAt: { $gte: new Date(process.env.SINCE) } };
  else if (cfsEnv) filter = { $or: [{ "stazioneAppaltante.cf": { $in: cfsEnv } }, { "aggiudicazioni.impresa.cf": { $in: cfsEnv } }] };
  else { const last = await runs.findOne({ kind: "linkage-incr" }, { sort: { at: -1 } }); filter = last?.at ? { _updatedAt: { $gte: last.at } } : {}; }

  // 2) estrai i soggetti candidati dal delta
  const cand = new Map<string, { denom: string; ruoli: Set<string> }>();
  const addS = (cf: string, den: string, ruolo: string) => {
    if (!cf || (cfsEnv && !cfsEnv.includes(cf))) return;
    let c = cand.get(cf); if (!c) { c = { denom: den || "", ruoli: new Set() }; cand.set(cf, c); }
    if (den && den.length > c.denom.length) c.denom = den; c.ruoli.add(ruolo);
  };
  for await (const l of (LIMIT ? lotti.find(filter).limit(LIMIT) : lotti.find(filter))) {
    if (l.stazioneAppaltante?.cf) addS(l.stazioneAppaltante.cf, l.stazioneAppaltante.denominazione, "buyer");
    for (const a of l.aggiudicazioni ?? []) addS(a.impresa.cf, a.impresa.denominazione, "supplier");
  }
  console.log(`→ ${cand.size} soggetti candidati nel delta`);

  // rigenera la riga `entita` dai membri correnti (robusto per tutti i casi)
  async function rebuildEntity(entityId: string): Promise<void> {
    const members = await S.find({ entityId }).toArray() as any[];
    if (members.length === 0) { await E.deleteOne({ _id: entityId }); return; }
    const cfs = members.map((m) => m.cf);
    const rep = cfs.find((c: string) => isValidPIVA(c)) ?? [...cfs].sort()[0];
    const repS = members.find((m) => m.cf === rep)!;
    const ruoli = [...new Set(members.flatMap((m) => m.ruoli))];
    await E.replaceOne({ _id: entityId }, { _id: entityId, entityId, cfRappresentante: rep, denominazioneCanonica: repS.denominazione, denominazioneNormalizzata: repS.denominazioneNormalizzata, membriCf: cfs, nMembri: cfs.length, ruoli }, { upsert: true });
  }

  // 3) processa ogni candidato contro il suo blocco
  let nProc = 0, nNewEnt = 0, nJoin = 0, nMerge = 0, nSkip = 0, nBlockMax = 0;
  const t0 = Date.now();
  for (const [cf, info] of cand) {
    const dn = normalizeDenominazione(info.denom);
    const existing = await S.findOne({ _id: cf }) as any;
    if (existing && existing.denominazioneNormalizzata === dn && existing.entityId) { nSkip++; continue; } // già indicizzato, invariato
    const bk = dn.slice(0, 3);
    const block = await S.find({ blockingKey: bk, _id: { $ne: cf } }).toArray() as any[];
    nBlockMax = Math.max(nBlockMax, block.length);
    const linked = new Set<string>();
    for (const b of block) {
      if (!isCandidate(dn, b.denominazioneNormalizzata)) continue;
      const v = linkVerdict(cf, b.cf, dn, b.denominazioneNormalizzata);
      if (v.tier === "merge" || v.tier === "bridge") linked.add(b.entityId);
    }

    let entityId: string;
    if (linked.size === 0) { entityId = "ent:" + cf; nNewEnt++; }
    else if (linked.size === 1) { entityId = [...linked][0]; nJoin++; }
    else {
      const ents = await E.find({ _id: { $in: [...linked] } }).toArray() as any[];
      ents.sort((a, b) => b.nMembri - a.nMembri || (a.entityId < b.entityId ? -1 : 1));
      entityId = ents[0].entityId;
      const absorbed = ents.slice(1).map((e) => e.entityId);
      await S.updateMany({ entityId: { $in: absorbed } }, { $set: { entityId } });
      await E.deleteMany({ _id: { $in: absorbed } });
      nMerge++;
    }
    await S.replaceOne({ _id: cf }, { _id: cf, cf, denominazione: info.denom, denominazioneNormalizzata: dn, ruoli: [...info.ruoli], blockingKey: bk, entityId }, { upsert: true });
    await rebuildEntity(entityId);
    nProc++;
  }

  const ms = Date.now() - t0;
  await runs.insertOne({ kind: "linkage-incr", at: new Date(), durationMs: ms, nCand: cand.size, nProc, nNewEnt, nJoin, nMerge, nSkip });
  console.log(`\n✓ linkage incrementale in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  processati: ${nProc} (saltati invariati: ${nSkip})`);
  console.log(`  (a) nuove entità: ${nNewEnt} · (b) join a cluster esistente: ${nJoin} · (c) entity-merge: ${nMerge}`);
  console.log(`  blocco max esaminato: ${nBlockMax} soggetti · ${nProc ? (ms / nProc).toFixed(1) : 0} ms/soggetto`);
  console.log(`  totali ora → soggetti: ${await S.estimatedDocumentCount()}, entità: ${await E.estimatedDocumentCount()}`);
  await closeClient();
}

main().catch((e) => { console.error("\n✗ linkage-incremental failed:", e); process.exitCode = 1; }).finally(closeClient);
