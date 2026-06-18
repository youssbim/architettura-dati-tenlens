// Esporta la collezione raw_pl in NDJSON gzippato, a shard, dentro data/raw_pl/.
// Streaming (cursor) → zero OOM. Ogni shard = SHARD_SIZE documenti.
// Snapshot fedele dei grezzi (così la pipeline si ri-esegue senza ri-scaricare da ANAC).
//
//   npm run export:raw-pl
//   SHARD_SIZE=100000 npm run export:raw-pl

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { db, closeClient } from "../lib/mongo";

const COLL = process.env.COLL ?? "raw_pl";
const SHARD_SIZE = Number(process.env.SHARD_SIZE ?? 100000);
const OUT_DIR = path.resolve(process.cwd(), `data/${COLL}`);

async function main(): Promise<void> {
  const t0 = Date.now();
  await mkdir(OUT_DIR, { recursive: true });
  const d = await db();
  const col = d.collection(COLL);
  const total = await col.estimatedDocumentCount();
  console.log(`${COLL}: ~${total} documenti → shard da ${SHARD_SIZE} in ${OUT_DIR}`);

  const cursor = col.find({}, { noCursorTimeout: true }).batchSize(2000);
  let shard = 0, inShard = 0, done = 0;
  let gz: ReturnType<typeof createGzip> | null = null;
  let fileDone: Promise<void> | null = null;

  const openShard = async () => {
    const name = `part-${String(shard).padStart(4, "0")}.ndjson.gz`;
    const out = createWriteStream(path.join(OUT_DIR, name));
    gz = createGzip();
    fileDone = pipeline(gz as unknown as Readable, out);
    return name;
  };
  const closeShard = async () => {
    if (!gz) return;
    gz.end();
    await fileDone;
    gz = null;
  };

  let current = await openShard();
  for await (const doc of cursor) {
    if (inShard >= SHARD_SIZE) {
      await closeShard();
      shard++; inShard = 0;
      current = await openShard();
    }
    // BSON → JSON: _id resta la stringa idAvviso; le date BSON diventano ISO
    if (!gz!.write(JSON.stringify(doc) + "\n")) {
      await new Promise((r) => gz!.once("drain", r));
    }
    inShard++; done++;
    if (done % 50000 === 0) console.log(`  ${done}/${total} → ${current}`);
  }
  await closeShard();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ esportati ${done} documenti in ${shard + 1} shard (${secs}s) → ${OUT_DIR}`);
}

main().catch((e) => { console.error("\n✗ export-raw-pl failed:", e); process.exitCode = 1; }).finally(closeClient);
