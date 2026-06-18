// L2 — linkage di Impresa/StazioneAppaltante con stessa denominazioneNormalizzata
// ma codice fiscale diverso. Crea archi STESSO_SOGGETTO_L2 (direzionato per
// elementId, idempotente) e logga ogni decisione su mongo.linkage_log.
//
// Quando esiste un L2 link tra X e Y, una query di analytics dovrebbe trattarli
// come la stessa entità — ma la decisione finale di MERGE umana resta in attesa.

import { read, write, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

type Label = "Impresa" | "StazioneAppaltante";

const CYPHER_LINK = (label: Label) => `
MATCH (a:${label}), (b:${label})
WHERE a.denominazioneNormalizzata IS NOT NULL
  AND a.denominazioneNormalizzata <> ""
  AND a.denominazioneNormalizzata = b.denominazioneNormalizzata
  AND a.cf <> b.cf
  AND elementId(a) < elementId(b)
MERGE (a)-[r:STESSO_SOGGETTO_L2]->(b)
  ON CREATE SET r.linkedAt = datetime(),
                r.rule = "denominazioneNormalizzata_exact"
RETURN labels(a) AS labels,
       a.cf AS leftCf, a.denominazione AS leftName,
       b.cf AS rightCf, b.denominazione AS rightName,
       a.denominazioneNormalizzata AS norm
`;

async function runForLabel(label: Label): Promise<number> {
  console.log(`→ L2 linkage su ${label}...`);
  const rows = await write<{
    labels: string[];
    leftCf: string;
    leftName: string;
    rightCf: string;
    rightName: string;
    norm: string;
  }>(CYPHER_LINK(label));

  if (rows.length === 0) {
    console.log(`  nessun duplicato trovato`);
    return 0;
  }

  const d = await db();
  await d.collection("linkage_log").insertMany(
    rows.map((r) => ({
      level: "L2",
      label,
      rule: "denominazioneNormalizzata_exact",
      norm: r.norm,
      left: { cf: r.leftCf, denominazione: r.leftName },
      right: { cf: r.rightCf, denominazione: r.rightName },
      createdAt: new Date(),
    })),
  );

  console.log(`  ${rows.length} coppie L2`);
  console.log("\n  esempi:");
  for (const r of rows.slice(0, 5)) {
    console.log(
      `    [${r.norm.padEnd(40)}]  ${r.leftName} (CF ${r.leftCf})  ↔  ${r.rightName} (CF ${r.rightCf})`,
    );
  }
  console.log();
  return rows.length;
}

async function main(): Promise<void> {
  const t0 = Date.now();

  // Numbers BEFORE for delta context
  const [{ before: beforeImp }] = await read<{ before: number }>(
    "MATCH ()-[r:STESSO_SOGGETTO_L2]->(:Impresa) RETURN count(r) AS before",
  );
  const [{ before: beforeSa }] = await read<{ before: number }>(
    "MATCH ()-[r:STESSO_SOGGETTO_L2]->(:StazioneAppaltante) RETURN count(r) AS before",
  );

  const newImp = await runForLabel("Impresa");
  const newSa = await runForLabel("StazioneAppaltante");

  console.log(
    `✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — Impresa pairs: ${newImp} (prima ${beforeImp})  ·  SA pairs: ${newSa} (prima ${beforeSa})`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ linkage-l2 failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
