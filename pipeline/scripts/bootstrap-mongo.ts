// Bootstrap MongoDB: create indexes for the Tenlens ingestion lake.
// Idempotent — MongoDB ignores creation of identical indexes.

import { db, closeClient } from "../lib/mongo";

async function main(): Promise<void> {
  const d = await db();

  console.log("→ Configuring 'raw_avvisi' (full avviso detail)...");
  const rawAvvisi = d.collection("raw_avvisi");
  // _id is idAvviso (UUID string). Other indexes:
  await rawAvvisi.createIndex({ idAppalto: 1, dataPubblicazione: -1 }, {
    name: "by_appalto_date",
  });
  await rawAvvisi.createIndex({ dataPubblicazione: -1 }, { name: "by_date" });
  await rawAvvisi.createIndex({ codiceScheda: 1 }, { name: "by_codice_scheda" });
  await rawAvvisi.createIndex({ tipo: 1 }, { name: "by_tipo" });
  await rawAvvisi.createIndex(
    { _synced: 1 },
    { name: "unsynced", partialFilterExpression: { _synced: false } },
  );
  await rawAvvisi.createIndex({ _ingestedAt: -1 }, { name: "by_ingested_at" });
  console.log("  ✓ indexes created on raw_avvisi");

  console.log("→ Configuring 'ingest_runs' (operational log)...");
  const runs = d.collection("ingest_runs");
  await runs.createIndex({ startedAt: -1 }, { name: "by_started" });
  console.log("  ✓ indexes created on ingest_runs");

  console.log("\n→ Verifying:");
  for (const name of ["raw_avvisi", "ingest_runs"]) {
    const idx = await d.collection(name).indexes();
    console.log(`  ${name}: ${idx.length} indexes`);
    for (const i of idx) {
      console.log(`    · ${i.name}  ${JSON.stringify(i.key)}`);
    }
  }
  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("bootstrap-mongo failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
