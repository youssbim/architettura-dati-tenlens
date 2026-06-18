// Ricerca semantica sui bandi: embedda la query (OpenAI) e fa cosine sui
// vettori `lotti.embedding`. Di default filtra i soli BANDI APERTI
// (dataScadenza ≥ oggi, non ancora aggiudicati) → "quali gare posso ancora fare".
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "./mongo";

const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

const cosine = (a: number[], b: number[]): number => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

export type BandoMatch = {
  cig: string;
  oggetto: string | null;
  natura: string | null;
  importoBase: number | null;
  dataScadenza: string | null;
  stazioneAppaltante: string | null;
  score: number;
};

export async function semanticSearchBandi(
  query: string,
  opts: { soloAperti?: boolean; k?: number; maxScan?: number } = {},
): Promise<BandoMatch[]> {
  const { soloAperti = true, k = 8, maxScan = 30000 } = opts;
  const { embedding } = await embed({ model: openai.embedding(EMBED_MODEL), value: query });
  const d = await db();
  const today = new Date().toISOString().slice(0, 10);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const filter: any = { embedding: { $exists: true } };
  if (soloAperti) {
    filter.dataScadenza = { $gte: today };       // scadenza futura
    filter["aggiudicazioni.0"] = { $exists: false }; // non ancora aggiudicato
  }
  const docs = await d.collection("lotti")
    .find(filter, { projection: { oggetto: 1, natura: 1, importoBase: 1, dataScadenza: 1, "stazioneAppaltante.denominazione": 1, embedding: 1 } })
    .limit(maxScan)
    .toArray() as any[];

  return docs
    .map((doc) => ({
      cig: doc._id as string,
      oggetto: doc.oggetto ?? null,
      natura: doc.natura ?? null,
      importoBase: doc.importoBase ?? null,
      dataScadenza: doc.dataScadenza ?? null,
      stazioneAppaltante: doc.stazioneAppaltante?.denominazione ?? null,
      score: cosine(embedding, doc.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
