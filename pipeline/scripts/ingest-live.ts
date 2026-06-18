// Live ingestion worker.
// Pages through ANAC /api/v0/avvisi from page 0, detects new idAvviso not yet
// in MongoDB raw_avvisi, fetches the full detail of each, and upserts it.
// Stops on the first page where ALL IDs are already known.
//
// Run with:
//   npm run ingest:live            # incremental, scans until full page is seen
//   MAX_PAGES=3 npm run ingest:live # stop after 3 pages (dev/test)
//
// Idempotent: re-running with no new data on ANAC ends with 0 new docs.

import { getAvvisi, getAvviso } from "../lib/anac";
import { db, closeClient } from "../lib/mongo";

const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 0) || Infinity;
const POLITE_DELAY_MS = Number(process.env.POLITE_DELAY_MS ?? 250);

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 800 * (i + 1);
      console.warn(
        `  ! ${label} failed (try ${i + 1}/${retries}): ${(e as Error).message}; retrying in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(
    `${label} failed after ${retries} retries: ${(lastErr as Error)?.message}`,
  );
}

async function parMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_avvisi");
  const runsCol = d.collection("ingest_runs");

  const run = await runsCol.insertOne({
    kind: "live",
    startedAt,
    status: "running",
    config: { PAGE_SIZE, CONCURRENCY, MAX_PAGES },
  });

  console.log(`→ ingest-live started (run ${run.insertedId})`);
  console.log(
    `  config: page_size=${PAGE_SIZE} concurrency=${CONCURRENCY} max_pages=${MAX_PAGES === Infinity ? "∞" : MAX_PAGES}`,
  );

  let totalNew = 0;
  let totalSeen = 0;
  let totalFetchErrors = 0;
  let pagesScanned = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await withRetry(`list page ${page}`, () =>
        getAvvisi({ page, size: PAGE_SIZE }),
      );
      pagesScanned++;

      if (list.content.length === 0) {
        console.log(`[page ${page}] empty → stop`);
        break;
      }

      const ids = list.content.map((a) => a.idAvviso);
      const seenDocs = await col
        .find({ _id: { $in: ids } as never }, { projection: { _id: 1 } })
        .toArray();
      const seen = new Set(seenDocs.map((doc) => doc._id as unknown as string));
      const newIds = ids.filter((id) => !seen.has(id));
      totalSeen += seen.size;

      console.log(
        `[page ${page}] ${ids.length} ids, ${seen.size} already seen, ${newIds.length} new`,
      );

      if (newIds.length === 0) {
        console.log(`  full page already known → stop`);
        break;
      }

      const details = await parMap(
        newIds,
        async (id) => {
          try {
            return await withRetry(`detail ${id}`, () => getAvviso(id), 2);
          } catch (e) {
            totalFetchErrors++;
            console.error(`  ✗ detail ${id}: ${(e as Error).message}`);
            return null;
          }
        },
        CONCURRENCY,
      );

      const ops = details
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((doc) => ({
          updateOne: {
            filter: { _id: doc.idAvviso as never },
            update: {
              $set: {
                ...doc,
                _id: doc.idAvviso,
                _ingestedAt: new Date(),
                _source: "live",
              },
              $setOnInsert: { _synced: false },
            },
            upsert: true,
          },
        }));

      if (ops.length) {
        const res = await col.bulkWrite(ops);
        const inserted = res.upsertedCount;
        const updated = res.modifiedCount;
        totalNew += inserted;
        console.log(
          `  ↳ upserted: ${inserted} new, ${updated} updated, ${ops.length - inserted - updated} unchanged`,
        );
      }

      if (POLITE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
      }
    }

    const endedAt = new Date();
    await runsCol.updateOne(
      { _id: run.insertedId },
      {
        $set: {
          status: "completed",
          endedAt,
          durationMs: Date.now() - t0,
          pagesScanned,
          totalNew,
          totalSeen,
          totalFetchErrors,
        },
      },
    );

    console.log(
      `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — pages=${pagesScanned} new=${totalNew} seen=${totalSeen} errors=${totalFetchErrors}`,
    );
  } catch (e) {
    await runsCol.updateOne(
      { _id: run.insertedId },
      {
        $set: {
          status: "error",
          endedAt: new Date(),
          durationMs: Date.now() - t0,
          error: (e as Error).message,
          pagesScanned,
          totalNew,
        },
      },
    );
    throw e;
  }
}

main()
  .catch((e) => {
    console.error("\n✗ ingest failed:", e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
