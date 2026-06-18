// Snapshot of the Tenlens ingestion state.
// Run: npm run ingest:status

import { db, closeClient } from "../lib/mongo";
import { sezioneFor } from "../lib/codici-scheda";

async function main(): Promise<void> {
  const d = await db();
  const col = d.collection("raw_avvisi");
  const runsCol = d.collection("ingest_runs");

  const total = await col.countDocuments();
  if (total === 0) {
    console.log("raw_avvisi: 0 documenti (mai ingestionato)");
    return;
  }

  const [oldest] = await col
    .find({}, { projection: { dataPubblicazione: 1 } })
    .sort({ dataPubblicazione: 1 })
    .limit(1)
    .toArray();
  const [newest] = await col
    .find({}, { projection: { dataPubblicazione: 1 } })
    .sort({ dataPubblicazione: -1 })
    .limit(1)
    .toArray();
  const [lastIngest] = await col
    .find({}, { projection: { _ingestedAt: 1 } })
    .sort({ _ingestedAt: -1 })
    .limit(1)
    .toArray();

  const unsynced = await col.countDocuments({ _synced: false });

  const byTipo = await col
    .aggregate([{ $group: { _id: "$tipo", c: { $sum: 1 } } }, { $sort: { c: -1 } }])
    .toArray();

  const byCodice = await col
    .aggregate([
      { $group: { _id: "$codiceScheda", c: { $sum: 1 } } },
      { $sort: { c: -1 } },
      { $limit: 12 },
    ])
    .toArray();

  console.log(`raw_avvisi:`);
  console.log(`  totale documenti  : ${total.toLocaleString("it-IT")}`);
  console.log(`  da sincronizzare  : ${unsynced.toLocaleString("it-IT")}`);
  console.log(
    `  dataPubblicazione : ${(oldest?.dataPubblicazione as string | undefined)?.slice(0, 19) ?? "—"}  →  ${(newest?.dataPubblicazione as string | undefined)?.slice(0, 19) ?? "—"}`,
  );
  console.log(
    `  ultimo ingest     : ${(lastIngest?._ingestedAt as Date | undefined)?.toISOString() ?? "—"}`,
  );

  console.log(`\n  per tipo:`);
  for (const row of byTipo) {
    console.log(`    · ${String(row._id).padEnd(12)} ${row.c.toLocaleString("it-IT")}`);
  }

  console.log(`\n  per codiceScheda (top 12):`);
  for (const row of byCodice) {
    const sez = sezioneFor(row._id as string);
    console.log(
      `    · ${String(row._id).padEnd(10)} [${sez.padEnd(6)}] ${row.c.toLocaleString("it-IT")}`,
    );
  }

  const recentRuns = await runsCol
    .find({})
    .sort({ startedAt: -1 })
    .limit(5)
    .toArray();
  if (recentRuns.length > 0) {
    console.log(`\nultime ${recentRuns.length} run di ingestion:`);
    for (const r of recentRuns) {
      const dur =
        typeof r.durationMs === "number"
          ? `${(r.durationMs / 1000).toFixed(1)}s`
          : "—";
      console.log(
        `  · ${(r.startedAt as Date).toISOString()}  [${r.status}]  pages=${r.pagesScanned ?? "—"} new=${r.totalNew ?? "—"} (${dur})`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error("status failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
