import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { dettaglioBando, ribassiPerCigs } from "@/lib/mongo";

const ES = process.env.ES_URL ?? "http://localhost:9200";
const INDEX = process.env.ES_INDEX ?? "bandi";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export type StimaResult = {
  ok: boolean;
  oggetto: string | null;
  importoBase: number | null;
  campione: number; // n. gare aggiudicate simili usate
  ribassoMediano: number; // 0..1
  ribassoP25: number;
  ribassoP75: number;
  quotaSenzaRibasso: number; // % del campione con ribasso ~0 (affidamento diretto)
  stima: { atteso: number; min: number; max: number } | null; // se importoBase noto
  note: string;
};

/**
 * Stima il prezzo di aggiudicazione atteso: trova gare AGGIUDICATE semanticamente
 * simili (kNN su ES), ne calcola la distribuzione del ribasso (da Mongo), e la
 * applica alla base d'asta. È una stima statistica con intervallo, non un prezzo
 * puntuale: molte gare (affidamento diretto) hanno ribasso ~0.
 */
export async function stimaPrezzo(input: {
  cig?: string;
  descrizione?: string;
  importoBase?: number;
}): Promise<StimaResult> {
  let oggetto = input.descrizione ?? null;
  let base = input.importoBase ?? null;

  if (input.cig) {
    const b = await dettaglioBando(input.cig);
    oggetto = b?.oggetto ?? oggetto;
    base = base ?? b?.importoBase ?? null;
  }
  if (!oggetto) {
    return {
      ok: false, oggetto: null, importoBase: base, campione: 0,
      ribassoMediano: 0, ribassoP25: 0, ribassoP75: 0, quotaSenzaRibasso: 0,
      stima: null, note: "Serve un CIG o una descrizione della gara.",
    };
  }

  // gare AGGIUDICATE semanticamente simili
  const { embedding } = await embed({ model: openai.embedding(EMBED_MODEL), value: oggetto });
  const r = await fetch(`${ES}/${INDEX}/_search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      knn: {
        field: "vec", query_vector: embedding, k: 80, num_candidates: 200,
        filter: { term: { aggiudicato: true } },
      },
      size: 80, _source: false,
    }),
  });
  const hits = (await r.json()).hits?.hits ?? [];
  const cigs = hits.map((h: { _id: string }) => h._id);

  const ribassi = (await ribassiPerCigs(cigs))
    .map((x) => (x.base - x.aggiudicato) / x.base)
    .filter((v) => v >= 0 && v < 1);

  if (ribassi.length < 5) {
    return {
      ok: false, oggetto, importoBase: base, campione: ribassi.length,
      ribassoMediano: 0, ribassoP25: 0, ribassoP75: 0, quotaSenzaRibasso: 0,
      stima: null, note: "Troppe poche gare simili aggiudicate per una stima affidabile.",
    };
  }

  const mediano = pct(ribassi, 0.5);
  const p25 = pct(ribassi, 0.25);
  const p75 = pct(ribassi, 0.75);
  const quotaZero = ribassi.filter((v) => v < 0.005).length / ribassi.length;

  const stima =
    base && base > 0
      ? {
          atteso: Math.round(base * (1 - mediano)),
          min: Math.round(base * (1 - p75)),
          max: Math.round(base * (1 - p25)),
        }
      : null;

  return {
    ok: true, oggetto, importoBase: base, campione: ribassi.length,
    ribassoMediano: mediano, ribassoP25: p25, ribassoP75: p75,
    quotaSenzaRibasso: quotaZero, stima,
    note:
      quotaZero > 0.6
        ? "La maggior parte delle gare simili è stata aggiudicata a base d'asta (ribasso ~0, tipico dell'affidamento diretto)."
        : "Stima basata sul ribasso osservato in gare simili aggiudicate.",
  };
}
