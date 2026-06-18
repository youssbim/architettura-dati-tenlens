/**
 * PIPELINE ETL — orchestratore.
 * Esegue i 4 stadi in ordine, fino allo storage canonico in MongoDB.
 * (Lo stadio ⑤ sync → Neo4j + Elasticsearch è separato, gira dopo.)
 *
 *   ① ingest    ANAC API ──▶ raw_pl, raw_ocds
 *   ② canonical raw_*    ──▶ lotti                [chiave: CIG]
 *   ③ linkage   lotti    ──▶ soggetti, entita     [blocking + 4 livelli]
 *   ④ embed     lotti    ──▶ lotti.embedding      [OpenAI 1536-dim]
 *
 * Ogni stadio è idempotente e stateless: lo stato è in Mongo, si riparte da lì.
 * Si possono saltare stadi con env: SKIP_INGEST / SKIP_CANONICAL / SKIP_LINKAGE / SKIP_EMBED.
 *
 *   npm run etl                 # pipeline completa
 *   SKIP_INGEST=true npm run etl # riprocessa il già scaricato (no rete ANAC)
 */

import { closeClient } from "@/lib/mongo";
import { runIngest } from "./1-ingest";
import { runCanonical } from "./2-canonical";
import { runLinkage } from "./3-linkage";
import { runEmbed } from "./4-embed";

const skip = (k: string) => process.env[k] === "true";

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("══ PIPELINE ETL — TendersLens ══\n");

  if (!skip("SKIP_INGEST")) await runIngest();
  else console.log("⏭  ① ingest saltato");

  if (!skip("SKIP_CANONICAL")) await runCanonical();
  else console.log("⏭  ② canonical saltato");

  if (!skip("SKIP_LINKAGE")) await runLinkage();
  else console.log("⏭  ③ linkage saltato");

  if (!skip("SKIP_EMBED")) await runEmbed();
  else console.log("⏭  ④ embed saltato");

  console.log(`\n══ ETL completato in ${((Date.now() - t0) / 1000).toFixed(0)}s ══`);
}

main()
  .catch((e) => { console.error("\n✗ pipeline failed:", e); process.exitCode = 1; })
  .finally(closeClient);
