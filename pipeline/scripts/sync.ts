// ⑤ SYNC — canonico (`lotti`) + entità risolte (`soggetti`/`entita`) → grafo Neo4j.
// Entity-level: UN nodo :Soggetto per `entityId` (label :Impresa/:StazioneAppaltante
// dai ruoli, CF membri in `cfs[]`). Gli archi HA_PUBBLICATO / AGGIUDICATO_A
// risolvono il CF del documento all'entityId (mappa costruita dai `soggetti`).
// MERGE ovunque → idempotente. Vedi docs/schema.md §B, docs/etl.md ⑤.
//
// Uso: npm run sync   (richiede build:index già eseguito)

import { db, closeClient } from "../lib/mongo";
import { write, closeDriver } from "../lib/neo4j";
import type { CanonicalLotto } from "../lib/model";

const BATCH = 500;

const C_SOGGETTO = `
UNWIND $rows AS r
MERGE (s:Soggetto {entityId: r.entityId})
  SET s.cfs=r.cfs, s.cfRappresentante=r.cfRappresentante,
      s.denominazione=r.den, s.denominazioneNormalizzata=r.denNorm, s.ruoli=r.ruoli
FOREACH (_ IN CASE WHEN 'buyer'    IN r.ruoli THEN [1] ELSE [] END | SET s:StazioneAppaltante)
FOREACH (_ IN CASE WHEN 'supplier' IN r.ruoli THEN [1] ELSE [] END | SET s:Impresa)`;

const C_LOTTO = `
UNWIND $rows AS r
MERGE (l:Lotto {cig: r.cig})
  SET l.oggetto=r.oggetto, l.natura=r.natura, l.importoBase=r.importoBase, l.procedura=r.procedura,
      l.luogoIstat=r.luogoIstat, l.garaIdPl=r.garaIdPl, l.garaIdOcds=r.garaIdOcds, l.sources=r.sources,
      l.dataPubblicazione = CASE WHEN r.dataPubblicazione IS NULL THEN null ELSE date(r.dataPubblicazione) END,
      l.dataScadenza = CASE WHEN r.dataScadenza IS NULL THEN null ELSE date(r.dataScadenza) END`;

const C_AVVISO = `
UNWIND $rows AS r
MERGE (a:Avviso {idAvviso: r.idAvviso})
  SET a.codiceScheda=r.codiceScheda, a.tipo=r.tipo, a.fonte=r.fonte, a.nuovoAvviso=r.nuovoAvviso,
      a.dataPubblicazione = CASE WHEN r.data IS NULL THEN null ELSE date(r.data) END
WITH r, a MATCH (l:Lotto {cig: r.cig}) MERGE (a)-[:RIGUARDA]->(l)
WITH r, a WHERE r.saEid IS NOT NULL
MATCH (s:Soggetto {entityId: r.saEid}) MERGE (s)-[:HA_PUBBLICATO]->(a)`;

const C_RETT = `
UNWIND $rows AS r
MATCH (older:Avviso {idAvviso: r.idAvviso})
MERGE (newer:Avviso {idAvviso: r.nuovoAvviso})
MERGE (newer)-[:RETTIFICA]->(older)`;

const C_AGG = `
UNWIND $rows AS r
MATCH (i:Soggetto {entityId: r.eid})
WITH r, i MATCH (l:Lotto {cig: r.cig})
MERGE (l)-[ag:AGGIUDICATO_A]->(i)
  SET ag.importo=r.importo, ag.esito=r.esito,
      ag.data = CASE WHEN r.data IS NULL THEN null ELSE date(r.data) END`;

const C_CPV = `
UNWIND $rows AS r
MERGE (c:Cpv {codice: r.codice})
WITH r, c MATCH (l:Lotto {cig: r.cig}) MERGE (l)-[:HA_CPV]->(c)`;

async function flush<T>(rows: T[], cypher: string): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await write(cypher, { rows: rows.slice(i, i + BATCH) });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();

  // mappa CF → entityId e righe soggetto (una per entità) dall'indice risolto
  const cf2eid = new Map<string, string>();
  for await (const s of d.collection("soggetti").find({}, { projection: { cf: 1, entityId: 1 } }))
    cf2eid.set(s.cf as string, s.entityId as string);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const soggR: any[] = [];
  for await (const e of d.collection("entita").find({}))
    soggR.push({ entityId: e.entityId, cfs: e.membriCf, cfRappresentante: e.cfRappresentante,
      den: e.denominazioneCanonica, denNorm: e.denominazioneNormalizzata, ruoli: e.ruoli });

  const lottoR: any[] = [], avvR: any[] = [], rettR: any[] = [], aggR: any[] = [], cpvR: any[] = [];
  let n = 0;
  for await (const l of d.collection<CanonicalLotto>("lotti").find({})) {
    n++;
    lottoR.push({ cig: l.cig, oggetto: l.oggetto, natura: l.natura, importoBase: l.importoBase, procedura: l.procedura,
      luogoIstat: l.luogo?.istat ?? null, garaIdPl: l.garaId?.pl ?? null, garaIdOcds: l.garaId?.ocds ?? null,
      sources: l._sources, dataPubblicazione: l.dataPubblicazione, dataScadenza: l.dataScadenza });
    const saEid = l.stazioneAppaltante?.cf ? cf2eid.get(l.stazioneAppaltante.cf) ?? null : null;
    for (const av of l.avvisi ?? []) {
      avvR.push({ idAvviso: av.idAvviso, codiceScheda: av.codiceScheda, tipo: av.tipo, fonte: av.fonte,
        nuovoAvviso: av.nuovoAvviso ?? null, data: av.data, cig: l.cig, saEid });
      if (av.nuovoAvviso) rettR.push({ idAvviso: av.idAvviso, nuovoAvviso: av.nuovoAvviso });
    }
    for (const ag of l.aggiudicazioni ?? []) {
      const eid = cf2eid.get(ag.impresa.cf);
      if (eid) aggR.push({ cig: l.cig, eid, importo: ag.importo, esito: ag.esito, data: ag.data });
    }
    for (const code of l.cpv ?? []) cpvR.push({ cig: l.cig, codice: code });
  }

  console.log(`→ ${soggR.length} entità · ${n} lotti · ${avvR.length} avvisi · ${aggR.length} aggiudicazioni · ${cpvR.length} cpv`);
  await flush(soggR, C_SOGGETTO); // prima i nodi entità: gli archi li MATCHano
  await flush(lottoR, C_LOTTO);
  await flush(avvR, C_AVVISO);
  await flush(rettR, C_RETT);
  await flush(aggR, C_AGG);
  await flush(cpvR, C_CPV);
  console.log(`\n✓ sync done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => { console.error("\n✗ sync failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDriver(); await closeClient(); });
