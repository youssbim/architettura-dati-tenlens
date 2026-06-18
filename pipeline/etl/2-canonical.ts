/**
 * STADIO ② — NORMALIZE + MERGE  (raw_* → MongoDB `lotti`)
 * ───────────────────────────────────────────────────────────
 *   ENTRA : raw_pl + raw_ocds  (i non ancora sincronizzati, _synced:false)
 *   ESCE  : collezione `lotti`  (CANONICA, un record per CIG)
 *   CHIAVE: CIG  →  replaceOne(upsert)
 *
 *   COSA FA, in 3 mosse:
 *     1. NORMALIZE — ogni doc grezzo passa per un adapter (adapter-pl / adapter-ocds)
 *        che lo traduce in "contributi" uniformi. L'adapter PL sa che lo stesso dato
 *        sta in campi diversi a seconda della scheda (P*=bando, AD3=esito, M*=modifica).
 *     2. RAGGRUPPA per CIG — tutti i contributi dello stesso CIG insieme (PL + OCDS).
 *     3. MERGE — li fonde in un Lotto: oggetto/importo dal bando, vincitore dall'esito.
 *
 *   PERCHÉ il CIG è la chiave: è l'unico codice IDENTICO tra le fonti
 *     (idAppalto di PL ≠ ocid di OCDS). È l'unica cosa che permette di dire
 *     "questi 3 documenti parlano della stessa gara".
 *
 *   CONTROFATTUALE (se NON lo facessi):
 *     · senza adapter-per-scheda → aggiudicatari pescati dal campo sbagliato →
 *       vincitore mancante sull'~84% degli avvisi (gli affidamenti diretti).
 *     · senza merge-per-CIG → la stessa gara compare come 2 nodi distinti
 *       (idAppalto≠ocid) → conteggi raddoppiati sulla sovrapposizione PL/OCDS.
 */

import { db, closeClient } from "@/lib/mongo";
import { plToContributi } from "@/lib/adapter-pl";
import { ocdsToContributi } from "@/lib/adapter-ocds";
import type { CanonicalLotto, Contributo } from "@/lib/model";
import { isMain } from "./_run";

// Fonde una lista di contributi dello stesso CIG nel record canonico.
// Regola: tiene il primo valore non-null (keep), accumula liste senza duplicati.
function mergeInto(existing: CanonicalLotto | null, cig: string, contribs: Contributo[]): CanonicalLotto {
  const now = new Date();
  const base: CanonicalLotto = existing ?? {
    _id: cig, cig, garaId: {}, oggetto: null, natura: null, cpv: [], importoBase: null,
    procedura: null, luogo: { nuts: null, istat: null }, dataPubblicazione: null, dataScadenza: null,
    stazioneAppaltante: null, aggiudicazioni: [], avvisi: [], rettifiche: [], link: null, _sources: [],
    _firstSeenAt: now, _updatedAt: now,
  };
  const keep = <T>(cur: T | null, v: T | null | undefined): T | null => cur ?? (v ?? null);

  for (const c of contribs) {
    base.oggetto = keep(base.oggetto, c.oggetto);
    base.natura = keep(base.natura, c.natura);
    base.importoBase = keep(base.importoBase, c.importoBase ?? null);
    base.procedura = keep(base.procedura, c.procedura);
    base.dataPubblicazione = keep(base.dataPubblicazione, c.dataPubblicazione);
    base.dataScadenza = keep(base.dataScadenza, c.dataScadenza);
    if (c.luogo) {
      base.luogo.nuts = base.luogo.nuts ?? (c.luogo.nuts ?? null);
      base.luogo.istat = base.luogo.istat ?? (c.luogo.istat ?? null);
    }
    if (c.stazioneAppaltante && !base.stazioneAppaltante) base.stazioneAppaltante = c.stazioneAppaltante;
    if (c.link) {
      if (!base.link) base.link = { piattaforma: null, ted: null };
      base.link.piattaforma = base.link.piattaforma ?? c.link.piattaforma;
      base.link.ted = base.link.ted ?? c.link.ted;
    }
    for (const code of c.cpv ?? []) if (!base.cpv.includes(code)) base.cpv.push(code);
    if (c.garaId) base.garaId[c.fonte] = c.garaId;
    if (!base._sources.includes(c.fonte)) base._sources.push(c.fonte);
    if (c.avviso && !base.avvisi.some((a) => a.idAvviso === c.avviso!.idAvviso)) base.avvisi.push(c.avviso);
    for (const ag of c.aggiudicazioni ?? [])
      if (!base.aggiudicazioni.some((x) => x.impresa.cf === ag.impresa.cf)) base.aggiudicazioni.push(ag);
    if (c.avviso?.nuovoAvviso && !base.rettifiche.some((r) => r.idAvviso === c.avviso!.idAvviso))
      base.rettifiche.push({ idAvviso: c.avviso.idAvviso, rifAvviso: c.avviso.nuovoAvviso, data: c.avviso.data });
  }
  base._updatedAt = now;
  return base;
}

// Quanti documenti grezzi tenere in memoria per volta. 2,3M avvisi NON ci stanno
// tutti insieme (OOM) → si processa a blocchi: la memoria resta limitata a un blocco.
const BATCH_DOCS = 20_000;

export type CanonicalResult = { docLetti: number; upserts: number; totale: number };

export async function runCanonical(): Promise<CanonicalResult> {
  const t0 = Date.now();
  const d = await db();
  const lotti = d.collection<CanonicalLotto>("lotti");
  await lotti.createIndex({ "stazioneAppaltante.cf": 1 }, { name: "by_sa" });
  await lotti.createIndex({ "aggiudicazioni.impresa.cf": 1 }, { name: "by_impresa" });

  let docLetti = 0, upserts = 0;

  // Processa una collezione grezza a BLOCCHI. Per ogni blocco:
  //   1. normalize+raggruppa per CIG (solo i contributi del blocco → memoria limitata)
  //   2. UNA find($in) per leggere i lotti esistenti di quei CIG  (1 round-trip, non N)
  //   3. merge + UNA bulkWrite di replaceOne(upsert)             (1 round-trip, non N)
  //   4. marca i grezzi del blocco come _synced
  // Cross-blocco: un CIG col bando nel blocco 1 e l'esito nel blocco 5 si fonde lo
  // stesso, perché il passo 2 rilegge il lotto già scritto. Idempotente + ripartibile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processCollection = async (coll: string, adapter: (doc: any) => Contributo[]): Promise<void> => {
    let byCig = new Map<string, Contributo[]>();
    let syncedIds: unknown[] = [];

    const flush = async () => {
      if (byCig.size === 0) return;
      const cigs = [...byCig.keys()];
      const existing = new Map(
        (await lotti.find({ _id: { $in: cigs as never } }).toArray()).map((l) => [l._id as unknown as string, l]),
      );
      await lotti.bulkWrite(
        cigs.map((cig) => ({
          replaceOne: {
            filter: { _id: cig as never },
            replacement: mergeInto(existing.get(cig) ?? null, cig, byCig.get(cig)!),
            upsert: true,
          },
        })) as never,
      );
      upserts += cigs.length;
      if (syncedIds.length)
        await d.collection(coll).updateMany(
          { _id: { $in: syncedIds as never } },
          { $set: { _synced: true, _syncedAt: new Date() } },
        );
      byCig = new Map();
      syncedIds = [];
    };

    for await (const doc of d.collection(coll).find({ _synced: false })) {
      docLetti++;
      syncedIds.push(doc._id);
      for (const c of adapter(doc)) {
        if (!byCig.has(c.cig)) byCig.set(c.cig, []);
        byCig.get(c.cig)!.push(c);
      }
      if (syncedIds.length >= BATCH_DOCS) {
        await flush();
        if (docLetti % 200_000 === 0) console.log(`  …${docLetti} grezzi processati (${coll})`);
      }
    }
    await flush();
  };

  await processCollection("raw_pl", plToContributi);
  await processCollection("raw_ocds", ocdsToContributi);

  const totale = await lotti.estimatedDocumentCount();
  console.log(`✓ ② canonical — ${docLetti} grezzi → ${upserts} upsert, lotti totale ${totale} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return { docLetti, upserts, totale };
}

if (isMain(import.meta.url)) runCanonical().finally(closeClient);
