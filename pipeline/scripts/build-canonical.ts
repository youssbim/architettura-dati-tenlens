// ②+③ NORMALIZE + MERGE — raw_pl (e raw_ocds) → collezione canonica `lotti`.
// Legge i documenti non sincronizzati, li trasforma in Contributi (adapter),
// li raggruppa per CIG e li fonde nel record canonico (upsert). Idempotente.
//
// Uso: npm run build:canonical

import { db, closeClient } from "../lib/mongo";
import { plToContributi } from "../lib/adapter-pl";
import { ocdsToContributi } from "../lib/adapter-ocds";
import type { CanonicalLotto, Contributo } from "../lib/model";

function mergeInto(existing: CanonicalLotto | null, cig: string, contribs: Contributo[]): CanonicalLotto {
  const now = new Date();
  const base: CanonicalLotto = existing ?? {
    _id: cig, cig, garaId: {}, oggetto: null, natura: null, cpv: [], importoBase: null,
    procedura: null, luogo: { nuts: null, istat: null }, dataPubblicazione: null, dataScadenza: null,
    stazioneAppaltante: null, aggiudicazioni: [], avvisi: [], rettifiche: [], link: null, _sources: [],
    _firstSeenAt: now, _updatedAt: now,
  };
  const keep = <T>(cur: T | null, v: T | null | undefined): T | null => (cur ?? (v ?? null));
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
    for (const code of c.cpv ?? []) if (!base.cpv.includes(code)) base.cpv.push(code);
    if (c.garaId) base.garaId[c.fonte] = c.garaId;
    if (!base._sources.includes(c.fonte)) base._sources.push(c.fonte);
    if (c.avviso && !base.avvisi.some((a) => a.idAvviso === c.avviso.idAvviso)) base.avvisi.push(c.avviso);
    for (const ag of c.aggiudicazioni ?? [])
      if (!base.aggiudicazioni.some((x) => x.impresa.cf === ag.impresa.cf)) base.aggiudicazioni.push(ag);
    if (c.avviso?.nuovoAvviso)
      base.rettifiche.push({ idAvviso: c.avviso.idAvviso, rifAvviso: c.avviso.nuovoAvviso, data: c.avviso.data });
  }
  base._updatedAt = now;
  return base;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const lotti = d.collection<CanonicalLotto>("lotti");
  await lotti.createIndex({ "stazioneAppaltante.cf": 1 }, { name: "by_sa" });
  await lotti.createIndex({ "aggiudicazioni.impresa.cf": 1 }, { name: "by_impresa" });

  // raccogli i contributi da TUTTE le fonti, raggruppati per CIG (agnostico)
  const byCig = new Map<string, Contributo[]>();
  const add = (c: Contributo) => { if (!byCig.has(c.cig)) byCig.set(c.cig, []); byCig.get(c.cig)!.push(c); };
  const synced: Record<string, unknown[]> = { raw_pl: [], raw_ocds: [] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ingest(coll: string, adapter: (doc: any) => Contributo[]): Promise<number> {
    let n = 0;
    for await (const doc of d.collection(coll).find({ _synced: false })) {
      n++; synced[coll].push(doc._id);
      for (const c of adapter(doc)) add(c);
    }
    return n;
  }

  const nPl = await ingest("raw_pl", plToContributi);
  const nOcds = await ingest("raw_ocds", ocdsToContributi);
  console.log(`→ ${nPl} doc raw_pl + ${nOcds} doc raw_ocds → ${byCig.size} CIG distinti`);

  let upserts = 0;
  for (const [cig, contribs] of byCig) {
    const existing = await lotti.findOne({ _id: cig });
    const merged = mergeInto(existing, cig, contribs);
    await lotti.replaceOne({ _id: cig }, merged, { upsert: true });
    upserts++;
  }

  for (const coll of Object.keys(synced))
    if (synced[coll].length)
      await d.collection(coll).updateMany({ _id: { $in: synced[coll] as never } }, { $set: { _synced: true, _syncedAt: new Date() } });

  const tot = await lotti.estimatedDocumentCount();
  console.log(`\n✓ build-canonical done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${upserts} lotti upsertati, totale ${tot}`);
}

main()
  .catch((e) => { console.error("\n✗ build-canonical failed:", e); process.exitCode = 1; })
  .finally(closeClient);
