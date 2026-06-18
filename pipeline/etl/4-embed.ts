/**
 * STADIO ④ — EMBEDDING  (lotti → MongoDB `lotti.embedding`)
 * ───────────────────────────────────────────────────────────
 *   ENTRA : `lotti.oggetto`  (solo quelli senza vettore o col testo cambiato)
 *   ESCE  : campo `lotti.embedding`  (vettore 1536-dim)
 *
 *   COSA FA: manda l'oggetto del lotto a OpenAI (text-embedding-3-small) e salva
 *     il vettore sul lotto. Batch grandi (embedMany) eseguiti IN PARALLELO.
 *
 *   IDEMPOTENTE: salta i lotti già embeddati per lo stesso testo (_embedText)
 *     → nel daily costa ~nulla.  Costo: ~$0,08 / 100k lotti.
 *
 *   A COSA SERVE: è la base della ricerca "trova bandi per significato".
 *     Il vettore vive in Mongo (verità/backup) e poi verrà copiato in ES (stadio ⑤).
 *
 *   CONTROFATTUALE (se NON lo facessi):
 *     la ricerca resterebbe SOLO lessicale (per parole) → "mensa" non troverebbe
 *     "refezione scolastica" (zero parole in comune, stesso significato).
 */

import { embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { db, closeClient } from "@/lib/mongo";
import type { CanonicalLotto } from "@/lib/model";
import { isMain } from "./_run";

const MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small"; // 1536 dim
const BATCH = Number(process.env.BATCH ?? 1000);            // input per richiesta (max OpenAI 2048)
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 10); // richieste in parallelo

const embedText = (l: CanonicalLotto): string =>
  [l.oggetto, l.natura].filter(Boolean).join(" — ").slice(0, 2000);

// esegue fn su items con al più n in parallelo
async function parMap<T>(items: T[], fn: (x: T) => Promise<void>, n: number): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export type EmbedResult = { embeddati: number; falliti: number; token: number; costoUsd: number };

export async function runEmbed(opts: { limit?: number } = {}): Promise<EmbedResult> {
  const t0 = Date.now();
  const LIMIT = opts.limit ?? (Number(process.env.LIMIT ?? 0) || Infinity);
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY mancante (stadio ④ embedding)");

  const d = await db();
  const L = d.collection<CanonicalLotto & { embedding?: number[]; _embedText?: string }>("lotti");
  const model = openai.embedding(MODEL);

  // 1) candidati: senza vettore o con oggetto cambiato (idempotenza)
  const cands: Array<{ id: string; text: string }> = [];
  let scanned = 0;
  for await (const l of L.find({}, { projection: { oggetto: 1, natura: 1, embedding: 1, _embedText: 1 } })) {
    if (scanned++ >= LIMIT) break;
    const text = embedText(l as CanonicalLotto);
    if (!text) continue;
    if (l.embedding && l._embedText === text) continue; // già fatto, identico
    cands.push({ id: l._id as unknown as string, text });
  }
  console.log(`  → ${cands.length} da embeddare (scan ${scanned})`);
  if (!cands.length) {
    console.log("✓ ④ embed — niente da fare");
    return { embeddati: 0, falliti: 0, token: 0, costoUsd: 0 };
  }

  // 2) batch → embedMany in parallelo
  const batches: Array<Array<{ id: string; text: string }>> = [];
  for (let i = 0; i < cands.length; i += BATCH) batches.push(cands.slice(i, i + BATCH));
  let done = 0, falliti = 0, token = 0, dim = 0;
  await parMap(
    batches,
    async (batch) => {
      try {
        const { embeddings, usage } = await embedMany({ model, values: batch.map((b) => b.text), maxRetries: 6 });
        token += usage?.tokens ?? 0;
        dim = embeddings[0]?.length ?? dim;
        await L.bulkWrite(
          batch.map((b, i) => ({
            updateOne: {
              filter: { _id: b.id as never },
              update: { $set: { embedding: embeddings[i], _embedText: b.text, _embedModel: MODEL, _embedDim: dim, _embeddedAt: new Date() } },
            },
          })) as never,
        );
        done += batch.length;
      } catch {
        falliti += batch.length; // batch fallito (rate-limit): si recupera al prossimo run (idempotente)
      }
    },
    CONCURRENCY,
  );

  const costoUsd = (token / 1_000_000) * 0.02;
  console.log(
    `✓ ④ embed — ${done} embeddati (dim ${dim}), ${falliti} falliti, ${token} token, ≈$${costoUsd.toFixed(4)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  return { embeddati: done, falliti, token, costoUsd };
}

if (isMain(import.meta.url)) runEmbed().finally(closeClient);
