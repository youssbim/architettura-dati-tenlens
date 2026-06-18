// Riepilogo del lavoro di record-linkage (pipeline CF-aware).
// Run: npm run linkage:status

import { read, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

async function main(): Promise<void> {
  console.log("== relazioni di linkage ==");
  const rels: Array<{ rel: string; label: string }> = [
    { rel: "STESSO_CIG", label: "CIG bridge (Appalto ↔ Appalto)" },
    { rel: "STESSO_SOGGETTO", label: "stesso ente (merge + bridge)" },
    { rel: "POSSIBILE_DUPLICATO", label: "da rivedere a mano" },
  ];
  for (const t of rels) {
    const [{ c }] = await read<{ c: number }>(
      `MATCH ()-[r:${t.rel}]->() RETURN count(r) AS c`,
    );
    console.log(`  ${t.rel.padEnd(20)} ${c.toLocaleString("it-IT").padStart(7)}    ${t.label}`);
  }

  // breakdown per tier degli archi STESSO_SOGGETTO
  const byTier = await read<{ tier: string; via: string; c: number }>(
    `MATCH ()-[r:STESSO_SOGGETTO]->()
     RETURN r.tier AS tier, r.via AS via, count(r) AS c ORDER BY c DESC`,
  );
  if (byTier.length) {
    console.log("\n  STESSO_SOGGETTO per tier/origine:");
    for (const row of byTier) console.log(`    ${String(row.tier).padEnd(8)} via ${String(row.via).padEnd(6)} ${row.c.toLocaleString("it-IT").padStart(7)}`);
  }

  // ultima run (mongo)
  const d = await db();
  const lastRun = await d
    .collection("linkage_runs")
    .find({ kind: "linkage-cf" })
    .sort({ at: -1 })
    .limit(1)
    .toArray();
  if (lastRun[0]) {
    const r = lastRun[0];
    console.log("\n== ultima run linkage-cf ==");
    console.log(`  data: ${new Date(r.at).toISOString()}  ·  imprese: ${r.imprese?.toLocaleString("it-IT")}`);
    console.log(`  merge ${r.counts?.merge} · bridge ${r.counts?.bridge} · review ${r.counts?.review} · reject ${r.counts?.reject}`);
    console.log(`  → ${r.stessoSoggetto} stesso-soggetto, ${r.possibileDuplicato} da rivedere, ${r.rejected} omonimi rifiutati`);
  }

  console.log("\n== esempi STESSO_SOGGETTO (bridge: CF persona ↔ P.IVA) ==");
  const exBridge = await read<{ a: string; b: string; an: string; bn: string }>(
    `MATCH (a:Impresa)-[r:STESSO_SOGGETTO {tier:'bridge'}]->(b:Impresa)
     RETURN a.denominazione AS a, b.denominazione AS b, a.cf AS an, b.cf AS bn LIMIT 5`,
  );
  for (const r of exBridge) console.log(`    ${r.a} (${r.an})  ↔  ${r.b} (${r.bn})`);

  console.log("\n== esempi POSSIBILE_DUPLICATO (da rivedere) ==");
  const exRev = await read<{ a: string; b: string }>(
    `MATCH (a:Impresa)-[r:POSSIBILE_DUPLICATO]->(b:Impresa)
     RETURN a.denominazione AS a, b.denominazione AS b LIMIT 5`,
  );
  for (const r of exRev) console.log(`    ${r.a}  ≈  ${r.b}`);
}

main()
  .catch((e) => {
    console.error("linkage-status failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
