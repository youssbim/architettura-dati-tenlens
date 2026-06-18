// EMBEDDING — vettore semantico dell'`oggetto` di ogni lotto → `lotti.embedding`.
// Idempotente (salta i lotti già embeddati per lo stesso testo). OpenAI
// text-embedding-3-small, batch grandi (embedMany) eseguiti IN PARALLELO.
//
// Uso:
//   LIMIT=100000 EMBED_CONCURRENCY=10 BATCH=1000 npm run embed:lotti
//   npm run embed:lotti                 # tutti i lotti senza vettore

import { embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { db, closeClient } from "../lib/mongo";
import type { CanonicalLotto } from "../lib/model";

const MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";
const DIM = Number(process.env.DIM ?? 0) || undefined;
const BATCH = Number(process.env.BATCH ?? 1000);          // input per richiesta embedMany (max OpenAI 2048)
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 10); // richieste in parallelo
const LIMIT = Number(process.env.LIMIT ?? 0) || Infinity;

const embedText = (l: CanonicalLotto): string => [l.oggetto, l.natura].filter(Boolean).join(" — ").slice(0, 2000);

async function parMap<T>(items: T[], fn: (x: T, i: number) => Promise<void>, n: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const L = d.collection<CanonicalLotto & { embedding?: number[]; _embedText?: string }>("lotti");
  const model = openai.embedding(MODEL, DIM ? { dimensions: DIM } : undefined);

  // 1) raccogli i candidati (senza vettore o con oggetto cambiato)
  console.log("→ raccolgo i candidati…");
  const cands: { id: string; text: string }[] = [];
  let scanned = 0;
  for await (const l of L.find({}, { projection: { oggetto: 1, natura: 1, embedding: 1, _embedText: 1 } })) {
    if (scanned++ >= LIMIT) break;
    const text = embedText(l as CanonicalLotto);
    if (!text) continue;
    if (l.embedding && l._embedText === text) continue;
    cands.push({ id: l._id as unknown as string, text });
  }
  console.log(`  ${cands.length} da embeddare (scan ${scanned})`);
  if (cands.length === 0) { console.log("✓ niente da fare"); await closeClient(); return; }

  // 2) batch → embedMany in parallelo
  const batches: { id: string; text: string }[][] = [];
  for (let i = 0; i < cands.length; i += BATCH) batches.push(cands.slice(i, i + BATCH));
  let done = 0, failed = 0, tokens = 0, dim = 0;
  await parMap(batches, async (batch) => {
    try {
      const { embeddings, usage } = await embedMany({ model, values: batch.map((b) => b.text), maxRetries: 6 });
      tokens += usage?.tokens ?? 0; dim = embeddings[0]?.length ?? dim;
      await L.bulkWrite(batch.map((b, i) => ({
        updateOne: { filter: { _id: b.id as never }, update: { $set: { embedding: embeddings[i], _embedText: b.text, _embedModel: MODEL, _embedDim: dim, _embeddedAt: new Date() } } },
      })) as never);
      done += batch.length;
      if (done % (BATCH * CONCURRENCY) < BATCH) console.log(`   …${done}/${cands.length} (${tokens} token)`);
    } catch (e) {
      failed += batch.length; // batch fallito (es. rate-limit): si recupera al prossimo run (idempotente)
    }
  }, CONCURRENCY);
  if (failed) console.log(`   ⚠️ ${failed} non embeddati (rate-limit?) → ri-eseguire per recuperarli`);

  const cost = (tokens / 1_000_000) * 0.02;
  const rate = done / ((Date.now() - t0) / 1000);
  console.log(`\n✓ embed-lotti done in ${((Date.now() - t0) / 1000).toFixed(1)}s — embeddati=${done} (${rate.toFixed(0)}/s), dim=${dim}, token=${tokens}, costo≈$${cost.toFixed(4)}`);
}

main().catch((e) => { console.error("\n✗ embed-lotti failed:", e); process.exitCode = 1; }).finally(closeClient);
