/**
 * STADIO ① — INGEST  (Pubblicità Legale → MongoDB `raw_pl`)
 * ───────────────────────────────────────────────────────────
 *   ENTRA : API ANAC Pubblicità Legale (feed live, ~2,3M avvisi)
 *   ESCE  : collezione `raw_pl`  (copia FEDELE dell'API, non trasformata)
 *   CHIAVE: idAvviso  →  upsert
 *
 *   IDEMPOTENTE: ri-eseguire trova lo stesso _id → aggiorna, non duplica.
 *                (misurato: re-upsert di 3.000 record → 0 nuovi)
 *
 *   PERCHÉ "keyset" e non "pagina N":
 *     paginare a offset costringe ANAC a ordinare tutti i 2,3M e a saltarne
 *     N×size → le pagine profonde misurano ~120s (vs ~36s in testa).
 *     Qui si spezza il dataset in FINESTRE DI DATA: ogni finestra è piccola,
 *     paginata da pagina 0 → offset basso → costo ~costante. Le finestre
 *     troppo grandi si auto-dividono a metà.
 *
 *   CONCORRENZA BASSA di proposito: 20 richieste parallele → il gateway ANAC
 *     molla 504 su tutte (misurato). 3 è il tetto reale.
 */

import { getAvvisiWindow, type AvvisoListItem } from "@/lib/anac";
import { db, closeClient } from "@/lib/mongo";
import { isMain } from "./_run";

// — manopole (col PERCHÉ accanto) —
const PAGE_SIZE = 5000; // pagine grandi = meno richieste
const PAGE_CONCURRENCY = 3; // oltre 3 → il gateway ANAC risponde 504
const MAX_PAGES_PER_WINDOW = 8; // sopra, la finestra si divide a metà
const POLITE_MS = 200;
const TIMEOUT_MS = 150_000;

// — date helper (DD/MM/yyyy ↔ Date, UTC mezzogiorno per non sballare il fuso) —
const fmt = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const parse = (s: string) => {
  const [dd, mm, yyyy] = s.split("/").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd, 12));
};
const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
};
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

// retry con backoff più lungo sui 504/timeout
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = (e as Error)?.message ?? "";
      const slow = msg.includes("504") || msg.includes("abort");
      await new Promise((r) => setTimeout(r, (slow ? 3000 : 800) * (i + 1)));
    }
  }
  throw new Error(`${label} failed: ${(last as Error)?.message}`);
}

export type IngestResult = { nuovi: number; finestre: number; split: number; totale: number };

export async function runIngest(opts: {
  startDate?: string;
  endDate?: string;
  skipKnown?: boolean;
} = {}): Promise<IngestResult> {
  const t0 = Date.now();
  const START = opts.startDate ?? process.env.START_DATE ?? "01/01/2024";
  const END = opts.endDate ?? process.env.END_DATE ?? fmt(new Date());
  const skipKnown = opts.skipKnown ?? process.env.SKIP_KNOWN !== "false";

  const d = await db();
  const col = d.collection("raw_pl");
  await col.createIndex({ dataPubblicazione: -1 }, { name: "by_data" }).catch(() => {});

  // upsert idempotente per idAvviso → ritorna quanti NUOVI
  const upsert = async (items: AvvisoListItem[]): Promise<number> => {
    if (!items.length) return 0;
    const ids = items.map((x) => x.idAvviso);
    const known = new Set(
      (await col.find({ _id: { $in: ids as never } }, { projection: { _id: 1 } }).toArray()).map(
        (x) => x._id as unknown as string,
      ),
    );
    const fresh = items.filter((x) => !known.has(x.idAvviso));
    if (!fresh.length) return 0;
    await col.bulkWrite(
      fresh.map((doc) => ({
        updateOne: {
          filter: { _id: doc.idAvviso as never },
          update: { $set: { ...doc, _id: doc.idAvviso, _synced: false, _ingestedAt: new Date() } },
          upsert: true,
        },
      })) as never,
    );
    return fresh.length;
  };

  // scarica tutte le pagine di una finestra "piccola" (≤ MAX), a bassa concorrenza
  const fetchWindow = async (s: string, e: string, totalPages: number, head: AvvisoListItem[]) => {
    let added = await upsert(head); // pagina 0 già scaricata dalla sonda
    for (let p = 1; p < totalPages; p += PAGE_CONCURRENCY) {
      const nums = Array.from({ length: Math.min(PAGE_CONCURRENCY, totalPages - p) }, (_, i) => p + i);
      const pages = await Promise.all(
        nums.map((pg) =>
          withRetry(
            () => getAvvisiWindow({ page: pg, size: PAGE_SIZE, start: s, end: e, timeoutMs: TIMEOUT_MS }),
            `win ${s}-${e} p${pg}`,
          ),
        ),
      );
      for (const pg of pages) added += await upsert(pg.content ?? []);
      await new Promise((r) => setTimeout(r, POLITE_MS));
    }
    return added;
  };

  // pila di finestre [start,end]; inizialmente l'intero range
  const stack: Array<[Date, Date]> = [[parse(START), parse(END)]];
  let nuovi = 0, finestre = 0, split = 0;

  while (stack.length) {
    const [a, b] = stack.pop()!;
    const sa = fmt(a), sb = fmt(b);

    // sonda: pagina 0 → quante pagine ha questa finestra?
    const probe = await withRetry(
      () => getAvvisiWindow({ page: 0, size: PAGE_SIZE, start: sa, end: sb, timeoutMs: TIMEOUT_MS }),
      `probe ${sa}-${sb}`,
    );
    const totalPages = probe.totalPages ?? 0;
    const head = probe.content ?? [];
    if ((probe.totalElements ?? 0) === 0) continue;

    // RESUME: se l'intera pagina 0 è già nota, assumo finestra già scaricata
    if (skipKnown && head.length && totalPages <= MAX_PAGES_PER_WINDOW) {
      const ids = head.map((x) => x.idAvviso);
      if ((await col.countDocuments({ _id: { $in: ids as never } })) === head.length) continue;
    }

    if (totalPages <= MAX_PAGES_PER_WINDOW || dayDiff(a, b) === 0) {
      // finestra gestibile → scaricala tutta
      nuovi += await fetchWindow(sa, sb, totalPages, head);
      finestre++;
    } else {
      // troppo grande → dividi a metà per data e rimetti in pila
      const mid = addDays(a, Math.floor(dayDiff(a, b) / 2));
      stack.push([addDays(mid, 1), b]);
      stack.push([a, mid]);
      split++;
    }
  }

  const totale = await col.estimatedDocumentCount();
  console.log(
    `✓ ① ingest — ${finestre} finestre, ${split} split, +${nuovi} nuovi, raw_pl=${totale} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  return { nuovi, finestre, split, totale };
}

if (isMain(import.meta.url)) runIngest().finally(closeClient);
