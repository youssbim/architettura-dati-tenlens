// Prova MISURATA di idempotenza dell'ETL.
// Ri-applica la pipeline su un campione di dati GIÀ caricati e verifica che
// i conteggi NON cambino (0 duplicati). Copre i due stadi:
//   1) Ingest (Mongo): re-upsert su chiave naturale _id → 0 inserimenti.
//   2) Sync  (Neo4j):  re-MERGE su chiavi naturali → 0 nodi/archi nuovi.
//
// Non scarica da ANAC: usa i documenti già presenti in raw_ocds_releases.
// Uso: npm run etl:idempotency   (IDEMP_SAMPLE=3000 di default)

import { db, closeClient } from "../lib/mongo";
import { read, write, closeDriver } from "../lib/neo4j";
import { ocdsToSyncRow, type OcdsSyncRow } from "../lib/transform-ocds";

const SAMPLE = Number(process.env.IDEMP_SAMPLE ?? 3000);
const BATCH = 500;

// stessi MERGE di sync-ocds.ts
const C_AV_APP = `
UNWIND $rows AS row
MERGE (av:Avviso {idAvviso: row.idAvviso})
  ON CREATE SET av.firstSeenAt = datetime()
  SET av.codiceScheda = row.codiceScheda, av.tipo = row.tipo,
      av.dataPubblicazione = CASE WHEN row.dataPubblicazione IS NULL THEN null ELSE datetime(row.dataPubblicazione) END,
      av.attivo = row.attivo, av.oscurato = row.oscurato, av.tags = row.tags, av.source = "ocds"
MERGE (app:Appalto {idAppalto: row.idAppalto})
  ON CREATE SET app.firstSeenAt = datetime()
  SET app.cig = coalesce(row.cig, app.cig), app.oggetto = coalesce(row.oggetto, app.oggetto),
      app.natura = coalesce(row.natura, app.natura), app.modalita = coalesce(row.modalita, app.modalita), app.source = "ocds"
MERGE (av)-[:RIGUARDA]->(app)`;
const C_SA = `
UNWIND $rows AS row UNWIND row.saList AS sa
MERGE (s:StazioneAppaltante {cf: sa.cf})
  SET s.denominazione = sa.denominazione, s.denominazioneNormalizzata = sa.denominazioneNormalizzata
WITH row, s MATCH (av:Avviso {idAvviso: row.idAvviso})
MERGE (s)-[r:HA_PUBBLICATO]->(av) SET r.data = av.dataPubblicazione`;
const C_AGG = `
UNWIND $rows AS row UNWIND row.aggiudicatari AS ag
MERGE (imp:Impresa {cf: ag.cf})
  SET imp.denominazione = ag.denominazione, imp.denominazioneNormalizzata = ag.denominazioneNormalizzata
WITH row, ag, imp MATCH (app:Appalto {idAppalto: row.idAppalto})
MERGE (app)-[r:AGGIUDICATO_A]->(imp)
  SET r.importo = ag.importo, r.modalita = row.modalita,
      r.data = CASE WHEN row.dataPubblicazione IS NULL THEN null ELSE datetime(row.dataPubblicazione) END`;
const C_CPV = `
UNWIND $rows AS row UNWIND row.cpvCodici AS code
MERGE (cpv:Cpv {codice: code})
WITH row, cpv MATCH (app:Appalto {idAppalto: row.idAppalto})
MERGE (app)-[:HA_CPV]->(cpv)`;

const LABELS = ["Avviso", "Appalto", "StazioneAppaltante", "Impresa", "Cpv"];
const RELS = ["RIGUARDA", "HA_PUBBLICATO", "AGGIUDICATO_A", "HA_CPV"];

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of LABELS) out[`(:${l})`] = (await read<{ c: number }>(`MATCH (n:\`${l}\`) RETURN count(n) AS c`))[0].c;
  for (const r of RELS) out[`[:${r}]`] = (await read<{ c: number }>(`MATCH ()-[x:\`${r}\`]->() RETURN count(x) AS c`))[0].c;
  return out;
}

async function main(): Promise<void> {
  const d = await db();
  const col = d.collection("raw_ocds_releases");

  console.log(`Campione: ${SAMPLE} release già caricate.\n`);
  const sample = await col.find({ _synced: true }, { batchSize: BATCH }).limit(SAMPLE).toArray();
  console.log(`Recuperati ${sample.length} documenti.\n`);

  // ---------- STADIO 1: ingest (upsert Mongo) ----------
  const mongoBefore = await col.countDocuments({});
  const ops = sample.map((doc) => ({
    updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: { _id: doc._id } }, upsert: true },
  }));
  const t1 = Date.now();
  const res = await col.bulkWrite(ops as never);
  const mongoAfter = await col.countDocuments({});
  console.log("== STADIO 1 · INGEST (upsert su _id) ==");
  console.log(`  doc re-upsertati:   ${sample.length}`);
  console.log(`  inseriti (nuovi):   ${res.upsertedCount}   ${res.upsertedCount === 0 ? "✓" : "✗ DUPLICATI!"}`);
  console.log(`  count Mongo:        ${mongoBefore} → ${mongoAfter}   ${mongoBefore === mongoAfter ? "✓ invariato" : "✗ cambiato"}`);
  console.log(`  throughput:         ${Math.round(sample.length / ((Date.now() - t1) / 1000)).toLocaleString("it-IT")} rec/s\n`);

  // ---------- STADIO 2: sync (MERGE grafo) ----------
  const before = await snapshot();
  const rows: OcdsSyncRow[] = [];
  for (const doc of sample) {
    const r = ocdsToSyncRow(doc as never);
    if (r) rows.push(r);
  }
  const t2 = Date.now();
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    await write(C_AV_APP, { rows: b });
    await write(C_SA, { rows: b });
    await write(C_AGG, { rows: b });
    await write(C_CPV, { rows: b });
  }
  const after = await snapshot();

  console.log("== STADIO 2 · SYNC (re-MERGE di " + rows.length + " release) ==");
  console.log("  entità".padEnd(24), "prima".padStart(10), "dopo".padStart(10), "  Δ");
  console.log("  " + "-".repeat(52));
  let allZero = true;
  for (const k of [...LABELS.map((l) => `(:${l})`), ...RELS.map((r) => `[:${r}]`)]) {
    const delta = after[k] - before[k];
    if (delta !== 0) allZero = false;
    console.log("  " + k.padEnd(22), String(before[k]).padStart(10), String(after[k]).padStart(10), "  " + (delta === 0 ? "0 ✓" : `${delta > 0 ? "+" : ""}${delta} ✗`));
  }
  console.log(`  throughput sync:    ${Math.round(rows.length / ((Date.now() - t2) / 1000)).toLocaleString("it-IT")} rec/s`);

  console.log(`\n${allZero && res.upsertedCount === 0 ? "✅ IDEMPOTENTE — ri-eseguire l'ETL non crea duplicati né nuovi nodi/archi." : "⚠️ NON idempotente: vedi i Δ sopra."}`);
}

main()
  .catch((e) => { console.error("\n✗ idempotency-check failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDriver(); await closeClient(); });
