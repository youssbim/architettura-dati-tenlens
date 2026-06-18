// Riepilogo dei finding delle red flag.
// Run: npm run red-flag:status

import { db, closeClient } from "../lib/mongo";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

async function main(): Promise<void> {
  const d = await db();
  const col = d.collection("red_flag_findings");

  const total = await col.countDocuments();
  if (total === 0) {
    console.log("Nessun finding. Hai eseguito `npm run red-flag`?");
    return;
  }

  console.log(`== ${total} finding totali ==\n`);

  const byRule = await col
    .aggregate([
      {
        $group: {
          _id: "$rule",
          n: { $sum: 1 },
          high: { $sum: { $cond: [{ $eq: ["$severity", "high"] }, 1, 0] } },
          medium: { $sum: { $cond: [{ $eq: ["$severity", "medium"] }, 1, 0] } },
          low: { $sum: { $cond: [{ $eq: ["$severity", "low"] }, 1, 0] } },
          description: { $first: "$ruleDescription" },
        },
      },
      { $sort: { n: -1 } },
    ])
    .toArray();

  console.log("per regola:");
  for (const r of byRule) {
    const sev = `${r.high}h ${r.medium}m ${r.low}l`;
    console.log(
      `  ${String(r._id).padEnd(28)} ${String(r.n).padStart(4)}   (${sev})  ${r.description}`,
    );
  }

  console.log("\n== top 3 finding per regola (severity high prima) ==");
  for (const r of byRule) {
    const top = await col
      .find({ rule: r._id })
      .sort({
        severity: 1, // strings; we use field-based sort then handle visually
        detectedAt: -1,
      })
      .limit(20)
      .toArray();
    const sorted = top.sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity as keyof typeof SEVERITY_ORDER] ?? 3;
      const sb = SEVERITY_ORDER[b.severity as keyof typeof SEVERITY_ORDER] ?? 3;
      return sa - sb;
    });
    if (sorted.length === 0) continue;
    console.log(`\n• ${r._id} (${r.n} finding):`);
    for (const f of sorted.slice(0, 3)) {
      console.log(
        `    [${String(f.severity).toUpperCase().padEnd(6)}] ${f.description}`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error("red-flag-status failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
