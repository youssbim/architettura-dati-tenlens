// Sincronizza i documenti raw_ocds_releases con `_synced: false` dentro Neo4j.
// Stessa pipeline di sync-graph.ts ma con sorgente OCDS: la transform è diversa
// e in più si materializzano i nodi Cpv con la relazione HA_CPV.

import { db, closeClient } from "../lib/mongo";
import { write, closeDriver } from "../lib/neo4j";
import { ocdsToSyncRow, type OcdsSyncRow } from "../lib/transform-ocds";

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 500);

const CYPHER_AVVISO_APPALTO = `
UNWIND $rows AS row
MERGE (av:Avviso {idAvviso: row.idAvviso})
  ON CREATE SET av.firstSeenAt = datetime()
  SET av.codiceScheda = row.codiceScheda,
      av.tipo = row.tipo,
      av.dataPubblicazione = CASE WHEN row.dataPubblicazione IS NULL THEN null ELSE datetime(row.dataPubblicazione) END,
      av.attivo = row.attivo,
      av.oscurato = row.oscurato,
      av.tags = row.tags,
      av.source = "ocds"
MERGE (app:Appalto {idAppalto: row.idAppalto})
  ON CREATE SET app.firstSeenAt = datetime()
  SET app.cig = coalesce(row.cig, app.cig),
      app.oggetto = coalesce(row.oggetto, app.oggetto),
      app.natura = coalesce(row.natura, app.natura),
      app.modalita = coalesce(row.modalita, app.modalita),
      app.source = "ocds"
MERGE (av)-[:RIGUARDA]->(app)
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
      r.data = CASE WHEN row.dataPubblicazione IS NULL THEN null ELSE datetime(row.dataPubblicazione) END
`;

const CYPHER_CPV = `
UNWIND $rows AS row
UNWIND row.cpvCodici AS code
MERGE (cpv:Cpv {codice: code})
WITH row, cpv
MATCH (app:Appalto {idAppalto: row.idAppalto})
MERGE (app)-[:HA_CPV]->(cpv)
`;

async function processBatch(rows: OcdsSyncRow[]): Promise<void> {
  if (rows.length === 0) return;
  await write(CYPHER_AVVISO_APPALTO, { rows });
  await write(CYPHER_SA, { rows });
  await write(CYPHER_AGGIUDICATARI, { rows });
  await write(CYPHER_CPV, { rows });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_ocds_releases");
  const runsCol = d.collection("ingest_runs");

  const totalToSync = await col.countDocuments({ _synced: false });
  console.log(
    `→ sync-ocds: ${totalToSync.toLocaleString("it-IT")} release da sincronizzare`,
  );

  const startedAt = new Date();
  const run = await runsCol.insertOne({
    kind: "sync-ocds",
    startedAt,
    status: "running",
    config: { BATCH_SIZE },
  });

  let processed = 0;
  let skipped = 0;
  let saRefs = 0;
  let imprRefs = 0;
  let cpvRefs = 0;
  let buf: OcdsSyncRow[] = [];
  let bufIds: string[] = [];

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    await processBatch(buf);
    await col.updateMany(
      { _id: { $in: bufIds as never } },
      { $set: { _synced: true, _syncedAt: new Date() } },
    );
    saRefs += buf.reduce((a, r) => a + r.saList.length, 0);
    imprRefs += buf.reduce((a, r) => a + r.aggiudicatari.length, 0);
    cpvRefs += buf.reduce((a, r) => a + r.cpvCodici.length, 0);
    processed += buf.length;
    console.log(`  → batch ${buf.length} | totale processati: ${processed}`);
    buf = [];
    bufIds = [];
  }

  const cursor = col.find({ _synced: false }, { batchSize: BATCH_SIZE });
  for await (const doc of cursor) {
    const row = ocdsToSyncRow(doc as never);
    if (!row) {
      skipped++;
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            _synced: true,
            _syncedAt: new Date(),
            _syncSkipped: true,
          },
        },
      );
      continue;
    }
    buf.push(row);
    bufIds.push(doc._id as unknown as string);
    if (buf.length >= BATCH_SIZE) await flush();
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
        saRefs,
        imprRefs,
        cpvRefs,
      },
    },
  );

  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — processed=${processed} skipped=${skipped} sa=${saRefs} impr=${imprRefs} cpv=${cpvRefs}`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ sync-ocds failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
