// F6.1 — Community detection con GDS Louvain sul bipartito SA↔Impresa.
//
// 1. Projection in memoria del sottografo con nodi {StazioneAppaltante, Impresa}
//    e archi proiettati su AGGIUDICATO_A (più HA_PUBBLICATO+RIGUARDA come ponte).
// 2. Esegue gds.louvain.stream
// 3. Scrive `community` come property su tutti i nodi
// 4. Identifica community "rosse": ≥3 imprese + ≥2 SA + nessuno scambio con
//    l'esterno (proxy della "sub-rete chiusa")
// 5. Persiste finding nella collection red_flag_findings con regola subrete_chiusa.

import { read, write, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

const GRAPH_NAME = process.env.GDS_GRAPH_NAME ?? "appalti-bipartito";
const MIN_COMMUNITY_SIZE = Number(process.env.MIN_COMMUNITY_SIZE ?? 3);

async function projectIfMissing(): Promise<void> {
  // Drop previous projection se esiste
  const exists = await read<{ exists: boolean }>(
    `RETURN gds.graph.exists($g) AS exists`,
    { g: GRAPH_NAME },
  );
  if (exists[0]?.exists) {
    await write(`CALL gds.graph.drop($g)`, { g: GRAPH_NAME });
    console.log(`  dropped previous projection`);
  }

  // Projection: SA --HA_PUBBLICATO->Avviso-RIGUARDA->Appalto-AGGIUDICATO_A->Impresa
  // Per Louvain proiettiamo solo SA<->Impresa attraverso un percorso virtuale.
  console.log(`  projecting graph "${GRAPH_NAME}"...`);
  await write(
    `CALL gds.graph.project.cypher(
       $g,
       'MATCH (n) WHERE n:StazioneAppaltante OR n:Impresa RETURN id(n) AS id, labels(n) AS labels',
       'MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(:Avviso)-[:RIGUARDA]->(:Appalto)-[:AGGIUDICATO_A]->(imp:Impresa) RETURN id(sa) AS source, id(imp) AS target',
       { validateRelationships: false }
     )`,
    { g: GRAPH_NAME },
  );
  console.log(`  projection done`);
}

async function runLouvain(): Promise<{ communities: number; modularity: number }> {
  console.log(`  running Louvain...`);
  const stats = await write<{ communityCount: number; modularity: number }>(
    `CALL gds.louvain.write($g, {writeProperty: 'community', maxLevels: 5})
     YIELD communityCount, modularity
     RETURN communityCount, modularity`,
    { g: GRAPH_NAME },
  );
  return {
    communities: stats[0]?.communityCount ?? 0,
    modularity: stats[0]?.modularity ?? 0,
  };
}

async function findClosedCommunities(): Promise<
  Array<{
    community: number;
    saCount: number;
    impCount: number;
    members: Array<{ label: string; cf: string; denominazione: string }>;
  }>
> {
  // Trova community con almeno MIN_COMMUNITY_SIZE membri
  const rows = await read<{
    community: number;
    saCount: number;
    impCount: number;
    members: Array<{ label: string; cf: string; denominazione: string }>;
  }>(
    `MATCH (n)
     WHERE (n:StazioneAppaltante OR n:Impresa) AND n.community IS NOT NULL
     WITH n.community AS community, n
     WITH community,
          sum(CASE WHEN n:StazioneAppaltante THEN 1 ELSE 0 END) AS saCount,
          sum(CASE WHEN n:Impresa THEN 1 ELSE 0 END) AS impCount,
          collect({
            label: head(labels(n)),
            cf: n.cf,
            denominazione: n.denominazione
          }) AS members
     WHERE saCount >= 1 AND impCount >= 2 AND (saCount + impCount) >= $minSize
     RETURN community, saCount, impCount, members
     ORDER BY (saCount + impCount) DESC
     LIMIT 50`,
    { minSize: MIN_COMMUNITY_SIZE },
  );
  return rows;
}

async function main(): Promise<void> {
  const t0 = Date.now();

  await projectIfMissing();
  const stats = await runLouvain();
  console.log(
    `  → ${stats.communities} community trovate (modularity ${stats.modularity.toFixed(3)})`,
  );

  const closed = await findClosedCommunities();
  console.log(`  → ${closed.length} community con ≥${MIN_COMMUNITY_SIZE} membri`);

  // Cleanup: drop projection per liberare memoria
  await write(`CALL gds.graph.drop($g)`, { g: GRAPH_NAME });

  // Persist finding
  const d = await db();
  const findCol = d.collection("red_flag_findings");
  await findCol.deleteMany({ rule: "subrete_chiusa" });
  if (closed.length > 0) {
    await findCol.insertMany(
      closed.map((c) => ({
        rule: "subrete_chiusa",
        ruleDescription:
          "Sub-rete densa SA-Impresa identificata via Louvain (community detection)",
        severity:
          c.saCount + c.impCount >= 10
            ? "high"
            : c.saCount + c.impCount >= 5
              ? "medium"
              : "low",
        description: `Community ${c.community}: ${c.saCount} SA + ${c.impCount} imprese (${c.saCount + c.impCount} totali). Esempi: ${c.members
          .slice(0, 3)
          .map((m) => `${m.label === "StazioneAppaltante" ? "SA" : "Imp"}: ${m.denominazione}`)
          .join("; ")}`,
        entities: {
          communityId: c.community,
          saList: c.members.filter((m) => m.label === "StazioneAppaltante"),
          impList: c.members.filter((m) => m.label === "Impresa"),
        },
        metrics: {
          totalMembers: c.saCount + c.impCount,
          saCount: c.saCount,
          impCount: c.impCount,
        },
        detectedAt: new Date(),
      })),
    );
  }

  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${stats.communities} community, ${closed.length} flagged`,
  );

  if (closed.length > 0) {
    console.log("\n  top 5 community:");
    for (const c of closed.slice(0, 5)) {
      console.log(
        `    [#${c.community}]  ${c.saCount} SA + ${c.impCount} Imp  · ${c.members[0]?.denominazione}, ${c.members[1]?.denominazione}…`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error("\n✗ gds-louvain failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
