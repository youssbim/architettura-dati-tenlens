// Stream-parsing dei bulk OCDS di ANAC.
// Scarica un mese (~700 MB) come stream, estrae le release del campo `releases`,
// e fa upsert in MongoDB.raw_ocds_releases (key = release.id).
//
// Per il PoC supporta MAX_RELEASES (es. =1000) per fermarsi presto senza
// scaricare il file intero. La connessione HTTP viene chiusa quando ci si ferma.
//
// Uso:
//   YEAR=2024 MONTH=1 MAX_RELEASES=2000 npm run ingest:ocds
//   YEAR=2024 MONTH=1 npm run ingest:ocds          # mese intero (lungo!)

import { db, closeClient } from "../lib/mongo";
import { Readable } from "node:stream";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

const YEAR = process.env.YEAR ?? "2024";
const MONTH = String(process.env.MONTH ?? "1").padStart(2, "0");
const URL = process.env.OCDS_URL ??
  `https://dati.anticorruzione.it/opendata/download/dataset/ocds/filesystem/bulk/${YEAR}/${MONTH}.json`;
const MAX_RELEASES = Number(process.env.MAX_RELEASES ?? 0) || Infinity;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 500);

const HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

type OcdsRelease = {
  id: string;
  ocid: string;
  [k: string]: unknown;
};

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_ocds");
  const runsCol = d.collection("ingest_runs");

  await col.createIndex({ ocid: 1 }, { name: "by_ocid" });
  await col.createIndex(
    { _synced: 1 },
    { name: "unsynced", partialFilterExpression: { _synced: false } },
  );
  await col.createIndex({ _ingestedAt: -1 }, { name: "by_ingested_at" });

  const startedAt = new Date();
  const run = await runsCol.insertOne({
    kind: "ingest-ocds",
    startedAt,
    status: "running",
    config: { URL, YEAR, MONTH, MAX_RELEASES, BATCH_SIZE },
  });

  console.log(`→ ingest-ocds: ${URL}`);
  console.log(
    `  config: max=${MAX_RELEASES === Infinity ? "∞" : MAX_RELEASES} batch=${BATCH_SIZE}`,
  );

  const controller = new AbortController();
  const response = await fetch(URL, {
    headers: HEADERS,
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  console.log(
    `  HTTP ${response.status}; size=${response.headers.get("content-length") ?? "?"} bytes`,
  );

  // Convert Web ReadableStream to Node Readable
  const nodeStream = Readable.fromWeb(response.body as never);

  const pipeline = chain([
    nodeStream,
    parser(),
    pick({ filter: "releases" }),
    streamArray(),
  ]);

  let total = 0;
  let buf: OcdsRelease[] = [];
  let bufIds: string[] = [];
  let errors = 0;
  let stopRequested = false;

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    const seen = new Set(
      (
        await col
          .find({ _id: { $in: bufIds as never } }, { projection: { _id: 1 } })
          .toArray()
      ).map((doc) => doc._id as unknown as string),
    );
    const ops = buf.map((rel, i) => {
      const id = bufIds[i];
      const isNew = !seen.has(id);
      return {
        updateOne: {
          filter: { _id: id as never },
          update: {
            $set: {
              ...rel,
              _id: id,
              _ingestedAt: new Date(),
              _source: "ocds",
            },
            ...(isNew ? { $setOnInsert: { _synced: false } } : {}),
          },
          upsert: true,
        },
      };
    });
    const res = await col.bulkWrite(ops);
    console.log(
      `  flushed ${ops.length}: ins=${res.upsertedCount} upd=${res.modifiedCount}  | total=${total}`,
    );
    buf = [];
    bufIds = [];
  }

  try {
    for await (const chunk of pipeline as AsyncIterable<{
      key: number;
      value: OcdsRelease;
    }>) {
      const rel = chunk.value;
      if (!rel || typeof rel.id !== "string" || typeof rel.ocid !== "string") {
        errors++;
        continue;
      }
      buf.push(rel);
      bufIds.push(rel.id);
      total++;
      if (buf.length >= BATCH_SIZE) await flush();
      if (total >= MAX_RELEASES) {
        stopRequested = true;
        controller.abort();
        break;
      }
    }
  } catch (e) {
    if (!stopRequested) {
      console.error("stream error:", (e as Error).message);
      errors++;
    }
  }
  await flush();

  await runsCol.updateOne(
    { _id: run.insertedId },
    {
      $set: {
        status: stopRequested ? "stopped_at_max" : "completed",
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        totalReleases: total,
        errors,
      },
    },
  );

  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — total=${total} errors=${errors}${stopRequested ? " (stopped at MAX_RELEASES)" : ""}`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ ingest-ocds failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
