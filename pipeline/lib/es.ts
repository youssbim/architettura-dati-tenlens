// Ricerca semantica su ELASTICSEARCH (kNN HNSW), alternativa al brute-force Mongo.
// L'indice `bandi` contiene il vettore + i metadati necessari a rispondere
// SENZA tornare su Mongo. Stesso contratto di output di semanticSearchBandi.
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import type { BandoMatch } from "./semantic";

const ES = process.env.ES_URL ?? "http://localhost:9200";
const INDEX = process.env.ES_INDEX ?? "bandi";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function esRequest(method: string, path: string, body?: any, ndjson = false): Promise<any> {
  const r = await fetch(ES + path, {
    method,
    headers: { "Content-Type": ndjson ? "application/x-ndjson" : "application/json" },
    body: ndjson ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// crea l'indice (idempotente: lo droppa e ricrea solo se forza=true)
export async function ensureIndex(dim: number, force = false): Promise<void> {
  const exists = await fetch(ES + `/${INDEX}`, { method: "HEAD" }).then((r) => r.ok);
  if (exists && !force) return;
  if (exists) await esRequest("DELETE", `/${INDEX}`).catch(() => {});
  await esRequest("PUT", `/${INDEX}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      properties: {
        vec: { type: "dense_vector", dims: dim, index: true, similarity: "cosine" },
        oggetto: { type: "text" },
        natura: { type: "keyword" },
        importoBase: { type: "double" },
        dataScadenza: { type: "date", format: "yyyy-MM-dd", ignore_malformed: true },
        stazioneAppaltante: { type: "keyword" },
        aggiudicato: { type: "boolean" },
      },
    },
  });
}

export const INDEX_NAME = INDEX;

// ricerca kNN; soloAperti → filtra scadenza futura e non aggiudicato (come Mongo)
export async function searchBandiES(
  query: string,
  opts: { soloAperti?: boolean; k?: number; numCandidates?: number } = {},
): Promise<BandoMatch[]> {
  const { soloAperti = true, k = 8, numCandidates = 100 } = opts;
  const { embedding } = await embed({ model: openai.embedding(EMBED_MODEL), value: query });
  const today = new Date().toISOString().slice(0, 10);

  const knn: any = { field: "vec", query_vector: embedding, k, num_candidates: numCandidates };
  if (soloAperti) {
    knn.filter = {
      bool: { filter: [{ range: { dataScadenza: { gte: today } } }, { term: { aggiudicato: false } }] },
    };
  }
  const res = await esRequest("POST", `/${INDEX}/_search`, {
    knn,
    size: k,
    _source: ["oggetto", "natura", "importoBase", "dataScadenza", "stazioneAppaltante"],
  });
  return (res.hits?.hits ?? []).map((h: any) => ({
    cig: h._id as string,
    oggetto: h._source?.oggetto ?? null,
    natura: h._source?.natura ?? null,
    importoBase: h._source?.importoBase ?? null,
    dataScadenza: h._source?.dataScadenza ?? null,
    stazioneAppaltante: h._source?.stazioneAppaltante ?? null,
    score: h._score as number,
  }));
}
