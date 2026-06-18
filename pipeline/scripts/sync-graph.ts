// Sincronizza i documenti `raw_avvisi` con `_synced: false` dentro Neo4j.
//
// Per ogni documento estrae SA, Aggiudicatari, Appalto, Avviso e crea
// (con MERGE idempotente) i nodi e le relazioni del grafo Tenlens.
//
// Lavora in batch di 500 documenti. Marca _synced: true alla fine di ogni batch.
// Re-eseguibile sempre: nessun duplicato grazie ai constraint UNIQUE.

import { db, closeClient } from "../lib/mongo";
import { write, closeDriver } from "../lib/neo4j";
import { toSyncRow, type SyncRow } from "../lib/transform";

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 500);

const CYPHER_AVVISO_APPALTO = `
UNWIND $rows AS row
MERGE (av:Avviso {idAvviso: row.idAvviso})
  ON CREATE SET av.firstSeenAt = datetime()
  SET av.codiceScheda = row.codiceScheda,
      av.tipo = row.tipo,
      av.dataPubblicazione = CASE WHEN row.dataPubblicazione = '' THEN null ELSE datetime(row.dataPubblicazione) END,
      av.attivo = row.attivo,
      av.oscurato = row.oscurato
MERGE (app:Appalto {idAppalto: row.idAppalto})
  ON CREATE SET app.firstSeenAt = datetime()
  SET app.cig = coalesce(row.cig, app.cig),
      app.oggetto = coalesce(row.oggetto, app.oggetto),
      app.natura = coalesce(row.natura, app.natura),
      app.luogo = coalesce(row.luogo, app.luogo),
      app.modalita = coalesce(row.modalita, app.modalita)
MERGE (av)-[:RIGUARDA]->(app)
`;

const CYPHER_RETTIFICA = `
UNWIND $rows AS row
WITH row
WHERE row.nuovoAvviso IS NOT NULL
MERGE (older:Avviso {idAvviso: row.idAvviso})
MERGE (newer:Avviso {idAvviso: row.nuovoAvviso})
MERGE (newer)-[:RETTIFICA]->(older)
`;

const CYPHER_SA = `
UNWIND $rows AS row
UNWIND row.saList AS sa
MERGE (s:StazioneAppaltante {cf: sa.cf})
  SET s.denominazione = sa.denominazione,
      s.denominazioneNormalizzata = sa.denominazioneNormalizzata
WITH row, s
MATCH (av:Avviso {idAvviso: row.idAvviso})
MERGE (s)-[r:HA_PUBBLICATO]->(av)
  SET r.data = av.dataPubblicazione
`;

const CYPHER_AGGIUDICATARI = `
UNWIND $rows AS row
UNWIND row.aggiudicatari AS ag
MERGE (imp:Impresa {cf: ag.cf})
  SET imp.denominazione = ag.denominazione,
      imp.denominazioneNormalizzata = ag.denominazioneNormalizzata
WITH row, ag, imp
MATCH (app:Appalto {idAppalto: row.idAppalto})
MERGE (app)-[r:AGGIUDICATO_A]->(imp)
  SET r.importo = ag.importo,
      r.modalita = row.modalita,
      r.data = CASE WHEN row.dataPubblicazione = '' THEN null ELSE datetime(row.dataPubblicazione) END
`;

async function processBatch(rows: SyncRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Le 4 statement girano in sessioni separate per chiarezza.
  // Sono comunque idempotenti grazie ai constraint UNIQUE.
  await write(CYPHER_AVVISO_APPALTO, { rows });
  await write(CYPHER_RETTIFICA, { rows });
  await write(CYPHER_SA, { rows });
  await write(CYPHER_AGGIUDICATARI, { rows });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_avvisi");
  const runsCol = d.collection("ingest_runs");

  const startedAt = new Date();
  const run = await runsCol.insertOne({
    kind: "sync-graph",
    startedAt,
    status: "running",
    config: { BATCH_SIZE },
  });

  const totalToSync = await col.countDocuments({ _synced: false });
  console.log(
    `→ sync-graph: ${totalToSync.toLocaleString("it-IT")} documenti da sincronizzare`,
  );

  let processed = 0;
  let skipped = 0;
  let saCount = 0;
  let impresaCount = 0;

  const cursor = col.find({ _synced: false }, { batchSize: BATCH_SIZE });

  let buf: SyncRow[] = [];
  let bufIds: string[] = [];

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    await processBatch(buf);
    await col.updateMany(
      { _id: { $in: bufIds as never } },
      { $set: { _synced: true, _syncedAt: new Date() } },
    );
    saCount += buf.reduce((a, r) => a + r.saList.length, 0);
    impresaCount += buf.reduce((a, r) => a + r.aggiudicatari.length, 0);
    processed += buf.length;
    console.log(
      `  → batch ${buf.length}: SA refs=${buf.reduce((a, r) => a + r.saList.length, 0)} Impr refs=${buf.reduce((a, r) => a + r.aggiudicatari.length, 0)}  | totale processati: ${processed}`,
    );
    buf = [];
    bufIds = [];
  }

  for await (const doc of cursor) {
    const row = toSyncRow(doc as never);
    if (!row) {
      skipped++;
      // marca comunque come synced per non riprovarlo all'infinito
      await col.updateOne(
        { _id: doc._id },
        { $set: { _synced: true, _syncedAt: new Date(), _syncSkipped: true } },
      );
      continue;
    }
    buf.push(row);
    bufIds.push(doc._id as unknown as string);
    if (buf.length >= BATCH_SIZE) {
      await flush();
    }
  }
  await flush();

  await runsCol.updateOne(
    { _id: run.insertedId },
    {
      $set: {
        status: "completed",
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        processed,
        skipped,
        saRefs: saCount,
        impresaRefs: impresaCount,
      },
    },
  );

  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — processed=${processed} skipped=${skipped} sa_refs=${saCount} impresa_refs=${impresaCount}`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ sync failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
