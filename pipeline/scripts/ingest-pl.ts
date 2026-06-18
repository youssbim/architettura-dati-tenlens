// ① INGEST — Pubblicità Legale → MongoDB raw_pl.
// La lista /avvisi restituisce GIÀ il `template` completo (sezioni A/B/C):
// NON serve la chiamata di dettaglio per avviso. Si pagina con `size` grande
// e si fa upsert dell'item-lista (idempotente, _id = idAvviso).
// Pagine scaricate in parallelo (PAGE_CONCURRENCY). Incrementale: si ferma
// quando un'intera tornata di pagine è già nota (per il daily).
//
// Uso:
//   MAX_PAGES=2 npm run ingest:pl                  # campione (2×1000)
//   npm run ingest:pl                              # incrementale fino al noto
//   START_PAGE=0 MAX_PAGES=500 PAGE_SIZE=1000 PAGE_CONCURRENCY=5 npm run ingest:pl   # bulk

import { getAvvisi } from "../lib/anac";
import { db, closeClient } from "../lib/mongo";

const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 5000); // pagine grandi = meno richieste, più dati (la leva vera)
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? 2); // il server ANAC serializza le parallele → poca concorrenza
const START_PAGE = Number(process.env.START_PAGE ?? 0);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 0) || Infinity;
const POLITE_MS = Number(process.env.POLITE_MS ?? 150);

async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 700 * (i + 1))); }
  }
  throw new Error(`${label} failed: ${(last as Error)?.message}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_pl");
  await col.createIndex({ _synced: 1 }, { name: "unsynced", partialFilterExpression: { _synced: false } });
  await col.createIndex({ dataPubblicazione: -1 }, { name: "by_data" });
  const runs = d.collection("ingest_runs");
  const run = await runs.insertOne({ kind: "ingest-pl", startedAt: new Date(), status: "running", config: { PAGE_SIZE, PAGE_CONCURRENCY, START_PAGE, MAX_PAGES } });

  let totalNew = 0, totalSeen = 0, stop = false;
  const endPage = START_PAGE + MAX_PAGES;
  for (let page = START_PAGE; page < endPage && !stop; page += PAGE_CONCURRENCY) {
    // scarica una tornata di pagine in parallelo
    const nums = Array.from({ length: Math.min(PAGE_CONCURRENCY, endPage - page) }, (_, i) => page + i);
    const results = await Promise.all(nums.map((p) => withRetry(() => getAvvisi({ page: p, size: PAGE_SIZE }), `page ${p}`)));

    const items: any[] = [];
    for (const res of results) {
      const c = (res as any).content ?? [];
      if (c.length === 0) stop = true; // pagina vuota → fine dataset
      items.push(...c);
    }
    if (items.length === 0) break;

    // incrementale: salta i già noti; se l'intera tornata è nota → stop
    const ids = items.map((x) => x.idAvviso);
    const known = new Set((await col.find({ _id: { $in: ids as never } }, { projection: { _id: 1 } }).toArray()).map((x) => x._id as unknown as string));
    const fresh = items.filter((x) => !known.has(x.idAvviso));
    if (fresh.length === 0) { console.log(`[pagine ${nums[0]}–${nums[nums.length - 1]}] tutte note → stop`); break; }

    const ops = fresh.map((doc) => ({
      updateOne: { filter: { _id: doc.idAvviso as never },
        update: { $set: { ...doc, _id: doc.idAvviso, _synced: false, _ingestedAt: new Date() } }, upsert: true },
    }));
    const r = await col.bulkWrite(ops as never);
    totalNew += r.upsertedCount; totalSeen += fresh.length;
    console.log(`[pagine ${nums[0]}–${nums[nums.length - 1]}] ${items.length} avvisi, ${known.size} noti, +${fresh.length} nuovi (tot nuovi ${totalNew})`);
    await new Promise((r) => setTimeout(r, POLITE_MS));
  }

  await runs.updateOne({ _id: run.insertedId }, { $set: { status: "completed", endedAt: new Date(), durationMs: Date.now() - t0, totalNew, totalSeen } });
  const count = await col.estimatedDocumentCount();
  const rate = totalSeen > 0 ? (totalSeen / ((Date.now() - t0) / 1000)).toFixed(0) : "0";
  console.log(`\n✓ ingest-pl done in ${((Date.now() - t0) / 1000).toFixed(1)}s — nuovi=${totalNew} (${rate} avvisi/s), raw_pl totale=${count}`);
}

main().catch((e) => { console.error("\n✗ ingest-pl failed:", e); process.exitCode = 1; }).finally(closeClient);
