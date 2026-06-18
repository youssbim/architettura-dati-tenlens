/**
 * STADIO ③ — RECORD LINKAGE  (lotti → MongoDB `soggetti` + `entita`)
 * ───────────────────────────────────────────────────────────────────
 *   ENTRA : `lotti`  (i CF di stazioni appaltanti e aggiudicatari)
 *   ESCE  : `soggetti` (1 per CF) · `entita` (entità reali risolte) · `linkage_review`
 *
 *   IL PROBLEMA: la stessa impresa compare con nomi diversi
 *     ("ROSSI COSTRUZIONI SRL" / "Rossi Costruzioni Srl" / "ROSSI COSTR.")
 *     e imprese diverse con nomi simili. Il nome inganna, il CF è l'identità.
 *
 *   COSA FA, in 3 mosse:
 *     1. ESTRAE i soggetti distinti per CF dai lotti.
 *     2. BLOCKING + linkVerdict — raggruppa per i primi 3 char del nome normalizzato
 *        (niente confronto tutti-vs-tutti) e dentro il blocco decide a 4 livelli sul CF:
 *           merge/bridge → stesso ente   · review → coda umana   · reject → distinti
 *        Regola: "generoso sui nomi, severo sul CF" (gli omonimi con P.IVA diverse NON si fondono).
 *     3. UNION-FIND → entità — fonde i CF dello stesso ente in un cluster (golden record + entityId).
 *
 *   PERCHÉ QUI (in Mongo, prima del grafo): risolvi le entità prima → il grafo nasce pulito.
 *
 *   CONTROFATTUALE (se NON facessi il blocking):
 *     confronto O(n²). Misurato sul campione: 7.041 soggetti = 24.784.320 coppie
 *     → ridotte dal blocking a 226 confronti reali (−99,999%). È il "costruisci un
 *     indice così non confronti tutti con tutti" chiesto dal prof.
 */

import { db, closeClient } from "@/lib/mongo";
import { normalizeDenominazione } from "@/lib/transform";
import { linkVerdict, editDistance, isValidPIVA } from "@/lib/cf";
import type { CanonicalLotto } from "@/lib/model";
import { isMain } from "./_run";

type Sogg = {
  _id: string; cf: string; denominazione: string; denominazioneNormalizzata: string;
  ruoli: string[]; blockingKey: string; entityId?: string;
};

// — soglie (col PERCHÉ accanto) —
const MIN_LEN = 8;     // sotto questa lunghezza il fuzzy è rumore
const MAX_EDIT = 2;    // max distanza di edit per il fuzzy
const MAX_REL = 0.2;   // edit relativo max (dist/len)
const BLOCK_CAP = 800; // blocchi enormi (omonimi): limita l'enumerazione

// union-find (chiusura transitiva: se A=B e B=C → A,B,C stesso ente)
const parent = new Map<string, string>();
function find(x: string): string {
  if (!parent.has(x)) parent.set(x, x);
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r)!;
  while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
  return r;
}
function union(a: string, b: string) {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
}

export type LinkageResult = {
  soggetti: number; entita: number; confronti: number; merge: number; review: number;
};

export async function runLinkage(opts: { limit?: number } = {}): Promise<LinkageResult> {
  const t0 = Date.now();
  const LIMIT = opts.limit ?? (Number(process.env.LIMIT ?? 0) || 0); // 0 = tutti
  parent.clear();

  const d = await db();
  const lotti = d.collection<CanonicalLotto>("lotti");
  const soggColl = d.collection<Sogg>("soggetti");
  const entColl = d.collection("entita");
  const revColl = d.collection("linkage_review");

  // 1) estrai i soggetti distinti per CF (NIENTE embedding nella projection → evita OOM)
  const map = new Map<string, Sogg>();
  const add = (cf: string, den: string, ruolo: string) => {
    if (!cf) return;
    let s = map.get(cf);
    if (!s) {
      const dn = normalizeDenominazione(den);
      s = { _id: cf, cf, denominazione: den, denominazioneNormalizzata: dn, ruoli: [], blockingKey: dn.slice(0, 3) };
      map.set(cf, s);
    }
    if (den && (!s.denominazione || den.length > s.denominazione.length)) {
      s.denominazione = den;
      s.denominazioneNormalizzata = normalizeDenominazione(den);
      s.blockingKey = s.denominazioneNormalizzata.slice(0, 3);
    }
    if (!s.ruoli.includes(ruolo)) s.ruoli.push(ruolo);
  };
  const proj = { projection: { stazioneAppaltante: 1, aggiudicazioni: 1 } };
  const cursor = LIMIT ? lotti.find({}, proj).limit(LIMIT) : lotti.find({}, proj);
  for await (const l of cursor) {
    if (l.stazioneAppaltante?.cf) add(l.stazioneAppaltante.cf, l.stazioneAppaltante.denominazione, "buyer");
    for (const a of l.aggiudicazioni ?? []) add(a.impresa.cf, a.impresa.denominazione, "supplier");
  }
  const soggetti = [...map.values()];
  console.log(`  → ${soggetti.length} soggetti distinti (per CF)`);

  // 2) blocking + linkVerdict + union-find
  const blocks = new Map<string, Sogg[]>();
  for (const s of soggetti) {
    if (!blocks.has(s.blockingKey)) blocks.set(s.blockingKey, []);
    blocks.get(s.blockingKey)!.push(s);
  }
  let merge = 0, confronti = 0;
  const reviews: Array<Record<string, unknown>> = [];
  for (const [, group] of blocks) {
    const g = group.length > BLOCK_CAP ? group.slice(0, BLOCK_CAP) : group;
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        const an = a.denominazioneNormalizzata, bn = b.denominazioneNormalizzata;
        // candidato: nome esatto (L2) o fuzzy entro soglia (L3)
        let cand = an === bn && an.length > 0;
        if (!cand && an.length >= MIN_LEN && bn.length >= MIN_LEN && Math.abs(an.length - bn.length) <= MAX_EDIT) {
          const dist = editDistance(an, bn);
          cand = dist >= 1 && dist <= MAX_EDIT && dist / Math.min(an.length, bn.length) <= MAX_REL;
        }
        if (!cand) continue;
        confronti++;
        const v = linkVerdict(a.cf, b.cf, an, bn); // decide sul CF, non sul nome
        if (v.tier === "merge" || v.tier === "bridge") { union(a.cf, b.cf); merge++; }
        else if (v.tier === "review")
          reviews.push({ a: a.cf, aDen: a.denominazione, b: b.cf, bDen: b.denominazione, reason: v.reason, createdAt: new Date() });
      }
  }

  // 3) cluster → entita + entityId su ogni soggetto
  const clusters = new Map<string, string[]>();
  for (const s of soggetti) {
    const r = find(s.cf);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(s.cf);
  }
  const byCf = new Map(soggetti.map((s) => [s.cf, s]));
  const entitaDocs: Array<Record<string, unknown>> = [];
  for (const [, members] of clusters) {
    const rep = members.find((cf) => isValidPIVA(cf)) ?? [...members].sort()[0]; // rappresentante = P.IVA valida, o CF minore
    const repS = byCf.get(rep)!;
    const ruoli = [...new Set(members.flatMap((cf) => byCf.get(cf)!.ruoli))];
    const entityId = "ent:" + rep;
    for (const cf of members) byCf.get(cf)!.entityId = entityId;
    entitaDocs.push({
      _id: entityId, entityId, cfRappresentante: rep,
      denominazioneCanonica: repS.denominazione, denominazioneNormalizzata: repS.denominazioneNormalizzata,
      membriCf: members, nMembri: members.length, ruoli,
    });
  }

  // scrivi su Mongo (rebuild pulito)
  await soggColl.deleteMany({}); await entColl.deleteMany({}); await revColl.deleteMany({});
  await soggColl.insertMany(soggetti as never);
  await soggColl.createIndex({ blockingKey: 1 });
  await soggColl.createIndex({ entityId: 1 });
  await soggColl.createIndex({ denominazioneNormalizzata: 1 });
  await entColl.insertMany(entitaDocs as never);
  if (reviews.length) await revColl.insertMany(reviews as never);

  console.log(
    `✓ ③ linkage — ${soggetti.length} soggetti → ${entitaDocs.length} entità · ${confronti} confronti · ${merge} merge · ${reviews.length} review (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  return { soggetti: soggetti.length, entita: entitaDocs.length, confronti, merge, review: reviews.length };
}

if (isMain(import.meta.url)) runLinkage().finally(closeClient);
