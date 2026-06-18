// L1.5 — bridge tra Appalti dello stesso CIG ma di sorgenti diverse
// (PL "Pubblicità Legale" usa idAppalto UUID, OCDS usa "ocds-hu01ve-...").
// Stesso CIG = stesso appalto reale.
//
// Crea (a1:Appalto)-[:STESSO_CIG {method:"cig_exact"}]->(a2:Appalto)
// con direzione deterministica via elementId per essere idempotente.

import { write, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

const CYPHER = `
MATCH (a1:Appalto), (a2:Appalto)
WHERE a1.cig IS NOT NULL
  AND a2.cig IS NOT NULL
  AND a1.cig = a2.cig
  AND a1.idAppalto <> a2.idAppalto
  AND elementId(a1) < elementId(a2)
MERGE (a1)-[r:STESSO_CIG]->(a2)
  ON CREATE SET r.linkedAt = datetime(),
                r.method = "cig_exact"
RETURN a1.idAppalto AS leftIdAppalto,
       a2.idAppalto AS rightIdAppalto,
       a1.cig AS cig
`;

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const logCol = d.collection("linkage_log");
  await logCol.createIndex({ level: 1, createdAt: -1 });

  console.log("→ linkage CIG bridge...");
  const rows = await write<{
    leftIdAppalto: string;
    rightIdAppalto: string;
    cig: string;
  }>(CYPHER);

  if (rows.length > 0) {
    await logCol.insertMany(
      rows.map((r) => ({
        level: "CIG_BRIDGE",
        rule: "cig_exact",
        cig: r.cig,
        left: r.leftIdAppalto,
        right: r.rightIdAppalto,
        createdAt: new Date(),
      })),
    );
  }

  console.log(`  ${rows.length} bridge creati (o già esistenti)`);
  if (rows.length > 0) {
    console.log("\n  esempi:");
    for (const r of rows.slice(0, 5)) {
      console.log(`    CIG ${r.cig.padEnd(12)}  ${r.leftIdAppalto}  ↔  ${r.rightIdAppalto}`);
    }
  }
  console.log(`\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("\n✗ linkage-cig failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
