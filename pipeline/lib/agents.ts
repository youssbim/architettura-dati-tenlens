// Assistente TendersLens — UN SINGOLO AGENTE (no multi-agent): un solo loop con
// tutti i tool, ognuno su uno store diverso. Mostra i 3 paradigmi insieme:
//   🔍 cercaBandi          → ELASTICSEARCH (ricerca semantica kNN HNSW)
//   📄 dettaglioBando      → MONGODB (documento canonico per CIG)
//   📊 profiloImpresa      → MONGODB (aggregazione storica)
//   🏛️ concentrazioneMercato → MONGODB (aggregazione su ente)
//   🕸️ reteImpresa         → NEO4J (traversata multi-hop: competitor via enti comuni)

import { tool } from "ai";
import { z } from "zod";
import { db } from "./mongo";
import { semanticSearchBandi } from "./semantic";
import { searchBandiES } from "./es";
import { read } from "./neo4j";
import { normalizeDenominazione } from "./transform";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────── ELASTICSEARCH: ricerca semantica ───────────────────
const cercaBandi = tool({
  description:
    "Ricerca SEMANTICA di bandi per significato (kNN su Elasticsearch). Data una descrizione di bisogno/settore, ritorna i bandi più affini. Default: solo bandi APERTI (scadenza futura, non aggiudicati).",
  inputSchema: z.object({
    query: z.string().describe("Bisogno o settore in linguaggio naturale (es. 'forniture dispositivi medici cateteri')."),
    soloAperti: z.boolean().default(true),
    k: z.number().int().min(1).max(12).default(8),
  }),
  execute: async ({ query, soloAperti, k }) => {
    try {
      const bandi = await searchBandiES(query, { soloAperti, k });
      return { count: bandi.length, soloAperti, motore: "elasticsearch", bandi };
    } catch {
      const bandi = await semanticSearchBandi(query, { soloAperti, k });
      return { count: bandi.length, soloAperti, motore: "mongo-bruteforce", bandi };
    }
  },
});

// ─────────────────── MONGODB: dettaglio + aggregazioni ───────────────────
const dettaglioBando = tool({
  description: "Dettaglio completo di un bando dato il suo CIG (documento canonico su MongoDB).",
  inputSchema: z.object({ cig: z.string() }),
  execute: async ({ cig }) => {
    const d = await db();
    const l = await d.collection("lotti").findOne(
      { _id: cig as any },
      { projection: { embedding: 0, _embedText: 0 } },
    );
    return l ?? { trovato: false, cig };
  },
});

// risolve un nome (impresa o ente) → lista di CF candidati, via indice soggetti
async function risolviCf(nome: string, ruolo: "supplier" | "buyer"): Promise<string[]> {
  const d = await db();
  const norm = normalizeDenominazione(nome);
  if (norm.length < 2) return [];
  const sogg = await d.collection("soggetti")
    .find({ denominazioneNormalizzata: { $regex: norm.slice(0, 24) }, ruoli: ruolo }, { projection: { cf: 1 } })
    .limit(8).toArray() as any[];
  return sogg.map((s) => s.cf);
}

const profiloImpresa = tool({
  description: "Profilo di un'impresa aggiudicataria (aggregazione MongoDB): quante gare ha vinto, importo totale, principali enti committenti.",
  inputSchema: z.object({ nome: z.string().describe("Denominazione dell'impresa") }),
  execute: async ({ nome }) => {
    const cfs = await risolviCf(nome, "supplier");
    if (!cfs.length) return { trovato: false, nome };
    const d = await db();
    const r = await d.collection("lotti").aggregate([
      { $match: { "aggiudicazioni.impresa.cf": { $in: cfs } } },
      { $unwind: "$aggiudicazioni" },
      { $match: { "aggiudicazioni.impresa.cf": { $in: cfs } } },
      { $group: {
        _id: "$aggiudicazioni.impresa.denominazione",
        nGare: { $sum: 1 },
        importoTot: { $sum: "$aggiudicazioni.importo" },
        enti: { $addToSet: "$stazioneAppaltante.denominazione" },
      } },
      { $sort: { nGare: -1 } }, { $limit: 3 },
    ]).toArray() as any[];
    return { trovato: r.length > 0, nome, varianti: r.map((x) => ({ denominazione: x._id, nGare: x.nGare, importoTot: x.importoTot, entiTop: (x.enti ?? []).slice(0, 6) })) };
  },
});

const concentrazioneMercato = tool({
  description: "Per una stazione appaltante (ente), aggregazione MongoDB: chi vince le sue gare e con che quota — concentrazione di mercato.",
  inputSchema: z.object({ ente: z.string().describe("Denominazione della stazione appaltante") }),
  execute: async ({ ente }) => {
    const cfs = await risolviCf(ente, "buyer");
    if (!cfs.length) return { trovato: false, ente };
    const d = await db();
    const top = await d.collection("lotti").aggregate([
      { $match: { "stazioneAppaltante.cf": { $in: cfs } } },
      { $unwind: "$aggiudicazioni" },
      { $group: { _id: "$aggiudicazioni.impresa.denominazione", nGare: { $sum: 1 }, importoTot: { $sum: "$aggiudicazioni.importo" } } },
      { $sort: { importoTot: -1 } }, { $limit: 10 },
    ]).toArray() as any[];
    const totGare = top.reduce((a, x) => a + x.nGare, 0);
    return { trovato: top.length > 0, ente, totGareCampione: totGare,
      topVincitori: top.map((x) => ({ impresa: x._id, nGare: x.nGare, importoTot: x.importoTot, quotaGare: totGare ? +(100 * x.nGare / totGare).toFixed(1) : 0 })) };
  },
});

// ─────────────────── NEO4J: traversata relazionale (competitor) ───────────────────
const reteImpresa = tool({
  description:
    "Rete competitiva di un'impresa (grafo NEO4J): trova i CONCORRENTI che vincono presso gli STESSI enti, via traversata multi-hop Impresa→Lotto→Ente→Lotto→Impresa. Usalo per 'chi sono i concorrenti di X', 'con chi compete X'.",
  inputSchema: z.object({ impresa: z.string().describe("Denominazione dell'impresa di cui mappare i concorrenti") }),
  execute: async ({ impresa }) => {
    const q = impresa.toUpperCase();
    const rows = await read<{ competitor: string; entiComuni: number; gareComuni: number }>(
      `MATCH (i:Impresa) WHERE toUpper(i.denominazione) CONTAINS $q
       WITH i ORDER BY COUNT { (i)-[:VINCE]->() } DESC LIMIT 1
       MATCH (i)-[:VINCE]->(:Lotto)<-[:BANDISCE]-(e:Ente)
       WITH i, collect(DISTINCT e) AS enti
       MATCH (e2:Ente)-[:BANDISCE]->(:Lotto)<-[:VINCE]-(comp:Impresa)
       WHERE e2 IN enti AND comp.cf <> i.cf
       RETURN comp.denominazione AS competitor, count(DISTINCT e2) AS entiComuni, count(*) AS gareComuni
       ORDER BY entiComuni DESC, gareComuni DESC LIMIT 8`,
      { q },
    );
    if (!rows.length) return { trovato: false, impresa, nota: "Nessuna impresa con quel nome ha aggiudicazioni nel grafo (300k recenti)." };
    return { trovato: true, impresa, motore: "neo4j", concorrenti: rows };
  },
});

// ─────────────────── L'UNICO AGENTE ───────────────────
export const assistantTools = {
  cercaBandi,
  dettaglioBando,
  profiloImpresa,
  concentrazioneMercato,
  reteImpresa,
};

export const ASSISTANT_SYSTEM = `Sei l'assistente TendersLens per gli appalti pubblici italiani (dati ANAC, ~300k bandi recenti).
Hai cinque strumenti, ognuno su uno store diverso — scegli quello giusto in base alla domanda:
- 🔍 cercaBandi (Elasticsearch): trovare bandi per significato/settore. Default: solo APERTI.
- 📄 dettaglioBando (MongoDB): tutti i dati di un CIG specifico.
- 📊 profiloImpresa (MongoDB): storico di un'impresa (gare vinte, importi, enti).
- 🏛️ concentrazioneMercato (MongoDB): chi domina le gare di un ente.
- 🕸️ reteImpresa (Neo4j): concorrenti di un'impresa via enti comuni (traversata sul grafo).

Regole:
- Usa più strumenti se serve (es. trova un'impresa con cercaBandi/profiloImpresa, poi mappane i concorrenti con reteImpresa).
- Non inventare CIG, numeri o nomi: usa solo ciò che torna dagli strumenti.
- Rispondi in italiano, conciso e concreto.`;
