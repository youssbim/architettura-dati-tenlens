// ① INGEST (BULK, keyset) — Pubblicità Legale → MongoDB raw_pl.
//
// Perché keyset e non offset: la paginazione a offset costringe ANAC a ordinare
// tutti i ~2,3M avvisi e a saltarne N×size → le pagine profonde misurano ~120s
// (vs ~36s in testa). Qui invece si spezza il dataset in FINESTRE DI DATA su
// `dataPubblicazione`: ogni finestra è piccola, paginata sempre da pagina 0 →
// offset basso → costo ~costante. Le finestre troppo grandi si auto-dividono a metà.
//
// Concorrenza BASSA di proposito: 20 richieste parallele → il gateway molla 504
// su tutte (misurato). 2-3 è il tetto reale.
//
// Idempotente: upsert per idAvviso → ri-eseguire non duplica e salta i già noti.
//
//   npm run ingest:pl:bulk                                  # 01/01/2024 → oggi
//   START_DATE=01/01/2024 END_DATE=31/12/2024 npm run ingest:pl:bulk
//   PAGE_SIZE=5000 PAGE_CONCURRENCY=2 MAX_PAGES_PER_WINDOW=8 npm run ingest:pl:bulk

import { getAvvisiWindow, type AvvisoListItem } from "../lib/anac";
import { db, closeClient } from "../lib/mongo";

const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 5000);
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? 2);
const MAX_PAGES_PER_WINDOW = Number(process.env.MAX_PAGES_PER_WINDOW ?? 8);
const POLITE_MS = Number(process.env.POLITE_MS ?? 200);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 150000);
const SKIP_KNOWN = process.env.SKIP_KNOWN !== "false"; // resume: salta finestre già scaricate

// — date helpers (DD/MM/yyyy ↔ Date, UTC midday per evitare derive di fuso) —
const fmt = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const parse = (s: string): Date => {
  const [dd, mm, yyyy] = s.split("/").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd, 12));
};
const addDays = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
};
const dayDiff = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / 86400000);

async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = (e as Error)?.message ?? "";
      const is504 = msg.includes("504") || msg.includes("aborted") || msg.includes("abort");
      const wait = (is504 ? 3000 : 800) * (i + 1); // backoff più lungo sui 504/timeout
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`${label} failed: ${(last as Error)?.message}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  const t0 = Date.now();
  const START = process.env.START_DATE ?? "01/01/2024";
  const END = process.env.END_DATE ?? fmt(new Date());

  const d = await db();
  const col = d.collection("raw_pl");
  await col.createIndex({ dataPubblicazione: -1 }, { name: "by_data" }).catch(() => {});
  const runs = d.collection("ingest_runs");
  const run = await runs.insertOne({
    kind: "ingest-pl-keyset",
    startedAt: new Date(),
    status: "running",
    config: { START, END, PAGE_SIZE, PAGE_CONCURRENCY, MAX_PAGES_PER_WINDOW },
  });

  const upsert = async (items: AvvisoListItem[]): Promise<number> => {
    if (items.length === 0) return 0;
    const ids = items.map((x) => x.idAvviso);
    const known = new Set(
      (await col.find({ _id: { $in: ids as never } }, { projection: { _id: 1 } }).toArray()).map(
        (x) => x._id as unknown as string,
      ),
    );
    const fresh = items.filter((x) => !known.has(x.idAvviso));
    if (fresh.length === 0) return 0;
    const ops = fresh.map((doc) => ({
      updateOne: {
        filter: { _id: doc.idAvviso as never },
        update: { $set: { ...doc, _id: doc.idAvviso, _synced: false, _ingestedAt: new Date() } },
        upsert: true,
      },
    }));
    const r = await col.bulkWrite(ops as never);
    return r.upsertedCount;
  };

  // tutte le pagine di una finestra "piccola" (totalPages ≤ MAX), a bassa concorrenza
  const fetchWindow = async (start: string, end: string, totalPages: number, head: AvvisoListItem[]) => {
    let added = await upsert(head); // pagina 0 già scaricata dalla sonda
    for (let p = 1; p < totalPages; p += PAGE_CONCURRENCY) {
      const nums = Array.from(
        { length: Math.min(PAGE_CONCURRENCY, totalPages - p) },
        (_, i) => p + i,
      );
      const pages = await Promise.all(
        nums.map((pg) =>
          withRetry(
            () => getAvvisiWindow({ page: pg, size: PAGE_SIZE, start, end, timeoutMs: TIMEOUT_MS }),
            `win ${start}-${end} p${pg}`,
          ),
        ),
      );
      for (const pg of pages) added += await upsert(pg.content ?? []);
      await new Promise((r) => setTimeout(r, POLITE_MS));
    }
    return added;
  };

  // pila di finestre [start,end] (Date), inizialmente l'intero range
  const stack: Array<[Date, Date]> = [[parse(START), parse(END)]];
  let totalNew = 0, windows = 0, splits = 0;

  while (stack.length) {
    const [a, b] = stack.pop()!;
    const sa = fmt(a), sb = fmt(b);

    // sonda: pagina 0 della finestra → quante pagine ha?
    const probe = await withRetry(
      () => getAvvisiWindow({ page: 0, size: PAGE_SIZE, start: sa, end: sb, timeoutMs: TIMEOUT_MS }),
      `probe ${sa}-${sb}`,
    );
    const totalPages = probe.totalPages ?? 0;
    const totalEl = probe.totalElements ?? 0;
    const head = probe.content ?? [];

    if (totalEl === 0) continue;

    // resume: se l'intera pagina 0 è già nota, assumo finestra già scaricata
    if (SKIP_KNOWN && head.length > 0) {
      const ids = head.map((x) => x.idAvviso);
      const knownCount = await col.countDocuments({ _id: { $in: ids as never } });
      if (knownCount === head.length && totalPages <= MAX_PAGES_PER_WINDOW) {
        console.log(`[${sa}→${sb}] ${totalEl} avvisi, già noti → skip`);
        continue;
      }
    }

    // finestra gestibile → scarica tutte le sue pagine
    if (totalPages <= MAX_PAGES_PER_WINDOW || dayDiff(a, b) === 0) {
      const added = await fetchWindow(sa, sb, totalPages, head);
      totalNew += added; windows++;
      console.log(`[${sa}→${sb}] ${totalEl} avvisi, ${totalPages} pag → +${added} nuovi (tot ${totalNew})`);
      continue;
    }

    // troppo grande → dividi a metà per data e rimetti in pila
    const mid = addDays(a, Math.floor(dayDiff(a, b) / 2));
    stack.push([addDays(mid, 1), b]);
    stack.push([a, mid]);
    splits++;
    console.log(`[${sa}→${sb}] ${totalEl} avvisi, ${totalPages} pag > ${MAX_PAGES_PER_WINDOW} → split @ ${fmt(mid)}`);
  }

  const secs = (Date.now() - t0) / 1000;
  await runs.updateOne(
    { _id: run.insertedId },
    { $set: { status: "completed", endedAt: new Date(), durationMs: Date.now() - t0, totalNew, windows, splits } },
  );
  const count = await col.estimatedDocumentCount();
  console.log(
    `\n✓ ingest-pl-keyset done in ${secs.toFixed(0)}s — ${windows} finestre, ${splits} split, +${totalNew} nuovi, raw_pl totale=${count}`,
  );
}

main().catch((e) => { console.error("\n✗ ingest-pl-keyset failed:", e); process.exitCode = 1; }).finally(closeClient);
