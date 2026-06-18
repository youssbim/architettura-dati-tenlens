// Snapshot del grafo Neo4j: conteggi per label/rel e top entità per grado.
// Run: npm run graph:status

import { read, closeDriver } from "../lib/neo4j";

async function main(): Promise<void> {
  console.log("== nodi per label ==");
  const labels = ["Avviso", "Appalto", "StazioneAppaltante", "Impresa", "Cpv"];
  for (const l of labels) {
    const [{ c }] = await read<{ c: number }>(
      `MATCH (n:${l}) RETURN count(n) AS c`,
    );
    console.log(`  ${l.padEnd(20)} ${c.toLocaleString("it-IT")}`);
  }

  console.log("\n== archi per tipo ==");
  const rels = [
    "RIGUARDA",
    "HA_PUBBLICATO",
    "AGGIUDICATO_A",
    "RETTIFICA",
    "HA_CPV",
    "STESSO_CIG",
    "STESSO_SOGGETTO",
    "POSSIBILE_DUPLICATO",
  ];
  for (const r of rels) {
    const [{ c }] = await read<{ c: number }>(
      `MATCH ()-[r:${r}]->() RETURN count(r) AS c`,
    );
    console.log(`  ${r.padEnd(20)} ${c.toLocaleString("it-IT")}`);
  }

  console.log("\n== top 5 stazioni appaltanti per numero di avvisi ==");
  const topSa = await read<{ denominazione: string; cf: string; cnt: number }>(
    `MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(av:Avviso)
     RETURN sa.denominazione AS denominazione, sa.cf AS cf, count(av) AS cnt
     ORDER BY cnt DESC LIMIT 5`,
  );
  for (const r of topSa) {
    console.log(`  ${r.cnt.toString().padStart(4)}  ${r.denominazione}  (CF ${r.cf})`);
  }

  console.log("\n== top 5 imprese per importo aggiudicato totale ==");
  const topImprese = await read<{
    denominazione: string;
    cf: string;
    totale: number;
    n: number;
  }>(
    `MATCH (a:Appalto)-[r:AGGIUDICATO_A]->(imp:Impresa)
     RETURN imp.denominazione AS denominazione, imp.cf AS cf,
            sum(coalesce(r.importo, 0)) AS totale,
            count(r) AS n
     ORDER BY totale DESC LIMIT 5`,
  );
  for (const r of topImprese) {
    const tot = r.totale.toLocaleString("it-IT", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    });
    console.log(`  ${tot.padStart(12)}  ${r.n} affidam.  ${r.denominazione}  (CF ${r.cf})`);
  }

  console.log("\n== distribuzione modalità di affidamento ==");
  const modal = await read<{ modalita: string; cnt: number }>(
    `MATCH ()-[r:AGGIUDICATO_A]->()
     RETURN r.modalita AS modalita, count(r) AS cnt
     ORDER BY cnt DESC`,
  );
  for (const r of modal) {
    console.log(`  ${(r.modalita ?? "—").padEnd(15)} ${r.cnt.toLocaleString("it-IT")}`);
  }
}

main()
  .catch((e) => {
    console.error("graph-status failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
