// Bootstrap Neo4j per il modello Tenlens (CIG-centric). Constraint di unicità
// + indici. Vedi docs/schema.md §B.3. Idempotente (IF NOT EXISTS).
// Run: npm run db:bootstrap:neo4j

import { write, closeDriver } from "../lib/neo4j";

const STMTS: string[] = [
  // il modello è entity-level: il Soggetto è una entità risolta (entityId),
  // non un CF. Rimuovo l'eventuale vincolo legacy sul cf.
  "DROP CONSTRAINT soggetto_cf IF EXISTS",
  // unicità (chiavi naturali)
  "CREATE CONSTRAINT soggetto_eid IF NOT EXISTS FOR (s:Soggetto) REQUIRE s.entityId IS UNIQUE",
  "CREATE CONSTRAINT lotto_cig   IF NOT EXISTS FOR (l:Lotto)    REQUIRE l.cig IS UNIQUE",
  "CREATE CONSTRAINT avviso_id   IF NOT EXISTS FOR (a:Avviso)   REQUIRE a.idAvviso IS UNIQUE",
  "CREATE CONSTRAINT cpv_codice  IF NOT EXISTS FOR (c:Cpv)      REQUIRE c.codice IS UNIQUE",
  // ricerca / raggruppamento (il blocking è lato Mongo, sull'indice `soggetti`)
  "CREATE INDEX sogg_denomNorm IF NOT EXISTS FOR (s:Soggetto) ON (s.denominazioneNormalizzata)",
  "CREATE INDEX sogg_cfs       IF NOT EXISTS FOR (s:Soggetto) ON (s.cfs)",
  "CREATE INDEX lotto_garaPl   IF NOT EXISTS FOR (l:Lotto)    ON (l.garaIdPl)",
  "CREATE INDEX lotto_garaOcds IF NOT EXISTS FOR (l:Lotto)    ON (l.garaIdOcds)",
];

async function main(): Promise<void> {
  for (const s of STMTS) {
    await write(s);
    console.log("  ✓ " + s.split(" IF NOT EXISTS")[0].replace("CREATE ", ""));
  }
  console.log("\n✓ bootstrap Neo4j completato (modello CIG-centric)");
}

main()
  .catch((e) => {
    console.error("✗ bootstrap-neo4j failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
