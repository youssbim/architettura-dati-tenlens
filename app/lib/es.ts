import { embed } from "ai";
import { openai } from "@ai-sdk/openai";

const ES = process.env.ES_URL ?? "http://localhost:9200";
const INDEX = process.env.ES_INDEX ?? "bandi";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

export type BandoMatch = {
  cig: string;
  oggetto: string | null;
  natura: string | null;
  importoBase: number | null;
  dataScadenza: string | null;
  stazioneAppaltante: string | null;
  score: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function esSearch(body: any): Promise<any> {
  const r = await fetch(`${ES}/${INDEX}/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ES ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/**
 * Ricerca SEMANTICA dei bandi: embedda la query con OpenAI e fa kNN (HNSW cosine)
 * sull'indice Elasticsearch `bandi` (vettori reali, 1536 dim).
 * `soloAperti` filtra le gare con scadenza futura non ancora aggiudicate.
 */
export async function ricercaSemantica(
  query: string,
  opts: { soloAperti?: boolean; k?: number } = {}
): Promise<BandoMatch[]> {
  const { soloAperti = false, k = 8 } = opts;
  const { embedding } = await embed({
    model: openai.embedding(EMBED_MODEL),
    value: query,
  });
  const today = new Date().toISOString().slice(0, 10);

  const knn: any = {
    field: "vec",
    query_vector: embedding,
    k,
    num_candidates: 100,
  };
  if (soloAperti) {
    knn.filter = {
      bool: {
        filter: [
          { range: { dataScadenza: { gte: today } } },
          { term: { aggiudicato: false } },
        ],
      },
    };
  }

  const res = await esSearch({
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

export type TemaResult = {
  totale: number;
  soglia: number;
  esempi: BandoMatch[];
};

/**
 * Classifica le gare per TEMA in modo semantico: embedda la descrizione del tema
 * e conta tutte le gare con similarità coseno >= soglia (copre il 100% del
 * dataset, gestisce i sinonimi, niente falsi positivi da keyword). Ritorna il
 * totale e alcuni esempi rappresentativi.
 */
export async function gareTema(
  tema: string,
  opts: { soglia?: number; k?: number; soloAperti?: boolean } = {}
): Promise<TemaResult> {
  const { soglia = 0.55, k = 8, soloAperti = false } = opts;
  const { embedding } = await embed({
    model: openai.embedding(EMBED_MODEL),
    value: tema,
  });

  const today = new Date().toISOString().slice(0, 10);
  const inner: any = soloAperti
    ? { bool: { filter: [{ range: { dataScadenza: { gte: today } } }, { term: { aggiudicato: false } }] } }
    : { match_all: {} };

  const res = await esSearch({
    size: k,
    track_total_hits: true,
    min_score: soglia + 1.0, // cosineSimilarity(...)+1.0
    query: {
      script_score: {
        query: inner,
        script: { source: "cosineSimilarity(params.q, 'vec') + 1.0", params: { q: embedding } },
      },
    },
    _source: ["oggetto", "natura", "importoBase", "dataScadenza", "stazioneAppaltante"],
  });

  return {
    totale: res.hits?.total?.value ?? 0,
    soglia,
    esempi: (res.hits?.hits ?? []).map((h: any) => ({
      cig: h._id as string,
      oggetto: h._source?.oggetto ?? null,
      natura: h._source?.natura ?? null,
      importoBase: h._source?.importoBase ?? null,
      dataScadenza: h._source?.dataScadenza ?? null,
      stazioneAppaltante: h._source?.stazioneAppaltante ?? null,
      score: (h._score as number) - 1.0,
    })),
  };
}
