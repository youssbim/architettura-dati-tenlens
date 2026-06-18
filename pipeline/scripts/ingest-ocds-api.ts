// ① INGEST OCDS via REST API → MongoDB raw_ocds (chiave = release.id).
// Alternativa leggera al bulk (700MB/mese): elenca gli OCID e scarica le
// release per OCID. Idempotente (upsert per release.id). Per il PoC / campione.
//
// Uso:
//   LIMIT=800 npm run ingest:ocds:api          # 800 ocid più recenti
//   LIMIT=800 OFFSET=0 CONCURRENCY=15 npm run ingest:ocds:api

import { db, closeClient } from "../lib/mongo";

const BASE = process.env.OCDS_BASE ?? "https://dati.anticorruzione.it/opendata/ocds/api/v1";
const HEADERS: HeadersInit = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/json" };
const LIMIT = Number(process.env.LIMIT ?? 800);
const OFFSET = Number(process.env.OFFSET ?? 0);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 15);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(path: string, timeoutMs = 20000): Promise<any> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { headers: HEADERS, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return await r.json();
  } finally { clearTimeout(to); }
}
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600 * (i + 1))); } }
  throw last;
}
async function parMap<T, R>(items: T[], fn: (x: T) => Promise<R>, n: number): Promise<R[]> {
  const out = new Array<R>(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("raw_ocds");
  await col.createIndex({ ocid: 1 }, { name: "by_ocid" });
  await col.createIndex({ _synced: 1 }, { name: "unsynced", partialFilterExpression: { _synced: false } });

  // 1. elenco OCID (la lista è lenta, ~15s → timeout ampio)
  const idsRes = await withRetry(() => get(`/releases/ocids?limit=${LIMIT}&offset=${OFFSET}&sortField=releaseDate&sortMode=DESC`, 40000));
  const ocids: string[] = (Array.isArray(idsRes) ? idsRes : idsRes.releases ?? []).map((x: any) => x.value ?? x.ocid ?? x).filter(Boolean);
  console.log(`→ ${ocids.length} OCID elencati, scarico le release…`);

  // 2. release per OCID (un gruppo = più versioni), con scrittura incrementale
  let docs = 0, upserts = 0, done = 0;
  let ops: any[] = [];
  const flush = async () => { if (!ops.length) return; const r = await col.bulkWrite(ops as never); upserts += r.upsertedCount; ops = []; };
  await parMap(ocids, async (ocid) => {
    const g = await withRetry(() => get(`/releases/${encodeURIComponent(ocid)}`, 15000)).catch(() => null);
    const rels: any[] = Array.isArray(g) ? g : g?.releases ?? (g ? [g] : []);
    for (const rel of rels) {
      if (!rel?.id) continue;
      docs++;
      ops.push({ updateOne: { filter: { _id: rel.id as never }, update: { $set: { ...rel, _id: rel.id, _synced: false, _ingestedAt: new Date() } }, upsert: true } });
    }
    if (++done % 100 === 0) { await flush(); console.log(`   …${done}/${ocids.length} ocid, ${docs} release`); }
  }, CONCURRENCY);
  await flush();

  const tot = await col.estimatedDocumentCount();
  console.log(`\n✓ ingest-ocds-api done in ${((Date.now() - t0) / 1000).toFixed(1)}s — release viste=${docs}, nuove=${upserts}, raw_ocds totale=${tot}`);
}

main().catch((e) => { console.error("\n✗ ingest-ocds-api failed:", e); process.exitCode = 1; }).finally(closeClient);
