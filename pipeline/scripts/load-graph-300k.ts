// Carica un GRAFO MINIMALE dai `lotti` (300k) dentro Neo4j, per le query relazionali
// della chat. Modello:
//   (:Ente {cf})-[:BANDISCE]->(:Lotto {cig})<-[:VINCE {importo}]-(:Impresa {cf})
// Idempotente (MERGE su chiavi naturali). Uso: npm run graph:load300k
import { db, closeClient } from "../lib/mongo";
import { write, closeDriver } from "../lib/neo4j";

const BATCH = Number(process.env.BATCH ?? 1000);

const CONSTRAINTS = [
  "CREATE CONSTRAINT lotto_cig IF NOT EXISTS FOR (l:Lotto) REQUIRE l.cig IS UNIQUE",
  "CREATE CONSTRAINT ente_cf IF NOT EXISTS FOR (e:Ente) REQUIRE e.cf IS UNIQUE",
  "CREATE CONSTRAINT impresa_cf IF NOT EXISTS FOR (i:Impresa) REQUIRE i.cf IS UNIQUE",
];

const CYPHER = `
UNWIND $rows AS row
MERGE (l:Lotto {cig: row.cig})
  SET l.oggetto = row.oggetto, l.importo = row.importo, l.dataScadenza = row.dataScadenza, l.aggiudicato = row.aggiudicato
FOREACH (_ IN CASE WHEN row.saCf IS NULL THEN [] ELSE [1] END |
  MERGE (e:Ente {cf: row.saCf}) SET e.denominazione = row.saDen
  MERGE (e)-[:BANDISCE]->(l))
WITH l, row
UNWIND (CASE WHEN size(row.agg) = 0 THEN [null] ELSE row.agg END) AS a
FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END |
  MERGE (imp:Impresa {cf: a.cf}) SET imp.denominazione = a.den
  MERGE (imp)-[v:VINCE]->(l) SET v.importo = a.importo)
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  for (const c of CONSTRAINTS) await write(c);
  const d = await db();
  const total = await d.collection("lotti").estimatedDocumentCount();
  console.log(`→ carico grafo da ${total} lotti (batch ${BATCH})…`);

  const cursor = d.collection("lotti").find({}, {
    projection: { oggetto: 1, importoBase: 1, dataScadenza: 1, "stazioneAppaltante.cf": 1, "stazioneAppaltante.denominazione": 1, aggiudicazioni: 1 },
  }) as any;

  let rows: any[] = [], n = 0, t0 = performance.now();
  const flush = async () => { if (rows.length) { await write(CYPHER, { rows }); rows = []; } };
  for await (const l of cursor) {
    const agg = Array.isArray(l.aggiudicazioni) ? l.aggiudicazioni
      .filter((a: any) => a?.impresa?.cf)
      .map((a: any) => ({ cf: a.impresa.cf, den: a.impresa.denominazione ?? null, importo: a.importo ?? null })) : [];
    rows.push({
      cig: l._id,
      oggetto: l.oggetto ?? null,
      importo: l.importoBase ?? null,
      dataScadenza: typeof l.dataScadenza === "string" ? l.dataScadenza : null,
      aggiudicato: agg.length > 0,
      saCf: l.stazioneAppaltante?.cf ?? null,
      saDen: l.stazioneAppaltante?.denominazione ?? null,
      agg,
    });
    n++;
    if (rows.length >= BATCH) { await flush(); if (n % 20000 === 0) console.log(`  …${n}/${total} (${((performance.now() - t0) / 1000).toFixed(0)}s)`); }
  }
  await flush();
  const [{ nl }] = await write<{ nl: number }>("MATCH (l:Lotto) RETURN count(l) AS nl");
  const [{ ne }] = await write<{ ne: number }>("MATCH (e:Ente) RETURN count(e) AS ne");
  const [{ ni }] = await write<{ ni: number }>("MATCH (i:Impresa) RETURN count(i) AS ni");
  const [{ nv }] = await write<{ nv: number }>("MATCH ()-[v:VINCE]->() RETURN count(v) AS nv");
  console.log(`✓ grafo: ${nl} Lotti, ${ne} Enti, ${ni} Imprese, ${nv} VINCE  (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  await closeClient();
  await closeDriver();
}

main().catch((e) => { console.error("✗ load-graph failed:", e); process.exitCode = 1; }).finally(async () => { await closeClient(); await closeDriver(); });
