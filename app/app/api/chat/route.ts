import { openai } from "@ai-sdk/openai";
import {
  streamText,
  convertToModelMessages,
  tool,
  stepCountIs,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { readCypher, risolviEntita, schemaGrafo, reteEntita } from "@/lib/neo4j";
import { ricercaSemantica, gareTema } from "@/lib/es";
import { dettaglioBando } from "@/lib/mongo";
import { stimaPrezzo } from "@/lib/stima";

export const maxDuration = 60;

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const SYSTEM = `Sei l'assistente di TenLens, una piattaforma di analisi degli appalti pubblici italiani (dati ANAC) modellati come grafo Neo4j.

Per QUALUNQUE domanda sui dati usa SEMPRE i tool: non rispondere mai a memoria su numeri, nomi o importi. Hai cinque strumenti — scegli in base al bisogno (le rispettive description spiegano quando usarli): risolviEntita (disambigua un nome), schemaGrafo (scopri nodi/relazioni non documentati), ricercaSemantica (cerca bandi per significato), dettaglioBando (scheda completa di un CIG da MongoDB), gareTema (conta/classifica le gare per TEMA semantico, es. quante sanitarie), metriche (aggrega e mostra un GRAFICO: distribuzioni, classifiche, andamenti), queryGrafo (interroga il grafo con Cypher), cercaWeb (ricerca sul web, SOLO per informazioni esterne ai dati ANAC: normativa, contesto, notizie su un'impresa/ente — mai per dati su gare/importi, che vivono nel grafo/Mongo).

RISOLUZIONE DEI NOMI (importante):
Quando la domanda filtra per un'entità citata per NOME (un'impresa o un ente, es. "Regione Basilicata", "Maggioli", "comune di milan"), NON passare il nome libero a queryGrafo. Procedi così:
1. Chiama PRIMA il tool risolviEntita con quel nome (e tipo se è chiaro che è "impresa" o "ente").
2. Tra i max 10 candidati restituiti scegli TU quello più pertinente (per denominazione e nGare; il nome può avere refusi o essere troncato — il full-text lo corregge, es. "comune di milan" → "COMUNE DI MILANO").
3. POI usa queryGrafo con MATCH ESATTO sulla chiave restituita, passandola TALE E QUALE (non rimuovere prefissi né cifre): per un Ente usa WHERE e.cf = $chiave; per un'Impresa usa WHERE i.cf = $chiave. Solo se la chiave non è un codice fiscale numerico, ripiega su WHERE <n>.denominazione = $denominazione. NON usare CONTAINS sul nome libero quando hai già risolto la chiave.
4. Se più candidati sono plausibili e ambigui, chiedi all'utente quale intende.
Per i confronti tra due entità (es. Maggioli vs Halley) risolvi entrambe prima di interrogare il grafo.

SCHEMA DEL GRAFO (usa esattamente questi nomi):
Nodi:
  (:Lotto)   una gara/lotto. props: cig, oggetto, importo, importoBase, procedura, natura, aggiudicato, dataPubblicazione, dataScadenza, luogoIstat
  (:Ente)    ente che bandisce. props: denominazione, cf
  (:Impresa) impresa. props: denominazione, denominazioneNormalizzata, cfs (lista), entityId
  (:Cpv)     categoria merceologica. props: codice, descrizione
Relazioni:
  (:Ente)-[:BANDISCE]->(:Lotto)
  (:Impresa)-[:VINCE]->(:Lotto)
  (:Lotto)-[:HA_CPV]->(:Cpv)

REGOLE per scrivere il Cypher:
- Solo lettura: MATCH/WHERE/RETURN/ORDER BY/LIMIT. Mai CREATE/DELETE/SET/MERGE.
- Includi sempre un LIMIT (max 50), tranne nei conteggi aggregati.
- Per i nomi usa match parziale case-insensitive: WHERE toLower(e.denominazione) CONTAINS toLower($q). I nomi nei dati sono spesso incompleti o scritti diversamente.
- Gli importi (l.importo) possono essere null: filtra IS NOT NULL quando aggreghi. Esistono outlier anomali, segnalalo se un valore è palesemente fuori scala.
- "chi vince le gare di un ente": (Ente)-[:BANDISCE]->(Lotto)<-[:VINCE]-(Impresa).
- Passa i valori come parametri ($q, $limit) quando possibile.
- Non inventare mai CIG, denominazioni o numeri: riportali solo se tornati dal grafo.
- ATTENZIONE: un WHERE dopo un OPTIONAL MATCH NON filtra i nodi del MATCH precedente (le righe restano tutte). Per filtrare per oggetto usa un MATCH/WHERE diretto su (l:Lotto). Es. "gare sui rifiuti": MATCH (l:Lotto) WHERE toLower(l.oggetto) CONTAINS 'rifiuti' RETURN count(l).

DECISIONE (evita di bloccarti): non esplorare lo schema o i nodi Cpv all'infinito. Dopo al massimo 2-3 chiamate a tool, RISPONDI con i dati che hai. Per argomenti tematici come "dispositivi medici", "sanitario", "farmaci" filtra direttamente l'oggetto del Lotto con toLower(l.oggetto) CONTAINS (es. 'dispositiv', 'medic', 'farmac') invece di passare dai nodi Cpv (i cui codici sono sporchi). Non chiedere chiarimenti se puoi dare una risposta sensata con un default ragionevole (tutta Italia, per numero di gare): rispondi e poi offri di affinare.

Rispondi in italiano, in modo conciso, citando i numeri reali ottenuti.
PUNTEGGIATURA: non usare mai il trattino lungo (— o –). Separa con virgole, punti, due punti o parentesi (es. "MYO S.p.A. (CF 03222970406): 66 gare condivise").
ELEMENTI CLICCABILI NEL TESTO (importante): le componenti interattive vanno SOLO nella tua risposta finale, mai altrove, e solo se sei TU a deciderlo perché utili.
- Per rendere apribile la scheda di un bando, cita il suo CIG come link markdown con schema cig:, es. [CIG BB3481679A](cig:BB3481679A). Si aprirà la scheda completa in un pannello. Non elencare tutti i campi del bando nel testo: una frase di sintesi + il link.
- Per le fonti web cita SEMPRE con un link markdown COMPLETO [dominio](URL_intero_https), usando l'URL completo restituito da cercaWeb. NON scrivere mai il nome del dominio tra parentesi come testo semplice (es. evita "(em.codiceappalti.it)"): deve essere un link cliccabile, che si aprirà dentro l'app. Cita una fonte solo se pertinente.
Non inserire questi link in modo automatico o massivo: mettili quando aiutano davvero l'utente.`;

const queryGrafo = tool({
  description: `Esegue una query Cypher in SOLA LETTURA sul grafo Neo4j degli appalti pubblici (ANAC) e restituisce le righe. È lo strumento per ottenere qualunque dato reale: ricerche, conteggi, classifiche, aggregazioni e relazioni.

Schema del grafo:
  (:Ente {denominazione, cf}) -[:BANDISCE]-> (:Lotto {cig, oggetto, importo, importoBase, procedura, natura, aggiudicato, dataPubblicazione, dataScadenza, luogoIstat})
  (:Impresa {denominazione, denominazioneNormalizzata, cf, cfs, entityId}) -[:VINCE]-> (:Lotto)
  (:Lotto) -[:HA_CPV]-> (:Cpv {codice, descrizione})

Come scrivere il Cypher:
- Solo lettura (MATCH/WHERE/RETURN/WITH/ORDER BY/LIMIT). CREATE/DELETE/SET/MERGE vengono rifiutati.
- Metti sempre un LIMIT (max 50), tranne nei conteggi aggregati.
- l.importo può essere NULL e contiene outlier anomali: filtra IS NOT NULL quando aggreghi e segnala i valori palesemente fuori scala.
- Filtra un'entità per la sua CHIAVE esatta (e.cf / i.cf) se l'hai già risolta con risolviEntita; usa toLower(...) CONTAINS solo per ricerche testuali libere (es. su l.oggetto).
- Un WHERE dopo un OPTIONAL MATCH non filtra i nodi del MATCH precedente: per filtrare usa un MATCH/WHERE diretto.
- Passa i valori come parametri ($limit, $cf, ...). Non inventare mai cig, nomi o numeri.

dataPubblicazione/dataScadenza sono stringhe ISO 'YYYY-MM-DD'. I valori di procedura e natura non sono normalizzati (es. 'affidamento_diretto' vs 'affidamento diretto').`,
  inputSchema: z.object({
    cypher: z.string().describe("La query Cypher di sola lettura da eseguire."),
    params: z
      .record(z.string(), z.any())
      .optional()
      .describe('Parametri della query, es. {"cf":"80002950766","limit":10}.'),
  }),
  execute: async ({ cypher, params }) => {
    try {
      const { columns, rows } = await readCypher(cypher, params ?? {});
      return { ok: true, columns, rowCount: rows.length, rows: rows.slice(0, 50) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const risolviEntitaTool = tool({
  description:
    "Risolve un nome impreciso/troncato/con refusi di un'impresa o di un ente nei candidati reali del grafo, usando un indice full-text fuzzy. Ritorna fino a 10 candidati con chiave (cf per Ente, entityId/denominazione per Impresa), denominazione, tipo, nGare e score. Chiamalo PRIMA di queryGrafo quando filtri per nome, poi passa la chiave esatta scelta a queryGrafo.",
  inputSchema: z.object({
    nome: z.string().describe("Il nome (anche impreciso) da risolvere, es. 'comune di milan'."),
    tipo: z
      .enum(["impresa", "ente"])
      .optional()
      .describe("Restringe la ricerca a sole imprese o soli enti, se noto."),
  }),
  execute: async ({ nome, tipo }) => {
    try {
      const candidati = await risolviEntita(nome, tipo);
      return { ok: true, count: candidati.length, candidati };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const schemaGrafoTool = tool({
  description:
    "Restituisce lo schema COMPLETO e aggiornato del grafo Neo4j (tutte le label coi rispettivi campi e tutte le relazioni from-tipo-to). Lo schema base in queryGrafo è solo un sottoinsieme: chiama questo tool quando la domanda potrebbe riguardare nodi o relazioni non documentati (es. aggiudicatari via Soggetto/AGGIUDICATO_A, avvisi, rettifiche/annullamenti via Avviso/RETTIFICA) per scoprire come interrogarli, poi usa queryGrafo.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      return { ok: true, ...(await schemaGrafo()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const ricercaSemanticaTool = tool({
  description:
    "Ricerca SEMANTICA dei bandi per SIGNIFICATO (non per parola esatta), via embedding + kNN su Elasticsearch. Usala quando l'utente cerca gare per argomento/tema e una ricerca testuale CONTAINS sarebbe troppo rigida (es. 'raccolta rifiuti' deve trovare anche 'igiene urbana', 'servizi ambientali'). Ritorna i bandi più affini con cig, oggetto, natura, importoBase, stazione appaltante e score. Per le domande strutturate (conteggi, classifiche, relazioni) usa invece queryGrafo.",
  inputSchema: z.object({
    query: z.string().describe("Il tema o l'argomento da cercare, in linguaggio naturale."),
    soloAperti: z
      .boolean()
      .optional()
      .describe("Se true, solo gare con scadenza futura non ancora aggiudicate."),
    k: z.number().optional().describe("Numero di risultati (default 8)."),
  }),
  execute: async ({ query, soloAperti, k }) => {
    try {
      const risultati = await ricercaSemantica(query, { soloAperti, k });
      return { ok: true, count: risultati.length, risultati };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const dettaglioBandoTool = tool({
  description:
    "Dato un CIG, restituisce la SCHEDA COMPLETA del bando dal documento canonico MongoDB: stato e aperto (campi già calcolati: aperto=true/false e stato='aperto'|'scaduto'|'aggiudicato'|'concluso/non datato' — usali per rispondere se un bando è ancora aperto, NON ricalcolarli), oggetto, importi, procedura, natura, CPV, luogo, date (dataScadenza è spesso null per le gare concluse), stazione appaltante completa, tutti gli aggiudicatari (cf, denominazione, importo, esito), avvisi e rettifiche, e link (piattaforma = dove consultare i documenti e partecipare; ted = avviso ufficiale UE su TED). Usalo per approfondire un bando, sapere se è aperto, o dare il link per partecipare. Neo4j ha pochi campi, qui c'è il record intero.",
  inputSchema: z.object({
    cig: z.string().describe("Il CIG del bando di cui mostrare il dettaglio completo."),
  }),
  execute: async ({ cig }) => {
    try {
      const bando = await dettaglioBando(cig);
      if (!bando) return { ok: false, error: `Nessun bando trovato per CIG ${cig}` };
      return { ok: true, bando };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const reteEntitaTool = tool({
  description:
    "Mostra la RETE/GRAFO visuale di relazioni di un'entità (ego-network): per un Ente, le imprese che vincono le sue gare; per un'Impresa, gli enti da cui vince. Peso = n. gare in comune. USA SEMPRE QUESTO (non metriche) quando l'utente dice 'rete', 'grafo', 'network', 'chi gravita attorno a', 'mappa delle relazioni', 'rete dei vincitori/fornitori'. Passa la CHIAVE (cf) da risolviEntita e il tipo. Disegna un grafo a nodi, non un grafico a barre.",
  inputSchema: z.object({
    cf: z.string().describe("Codice fiscale dell'entità (risolvilo prima con risolviEntita)."),
    tipo: z.enum(["ente", "impresa"]).describe("Se la chiave è un ente o un'impresa."),
  }),
  execute: async ({ cf, tipo }) => {
    try {
      const r = await reteEntita(cf, tipo);
      if (!r.vicini.length) return { ok: false, error: "Nessuna relazione trovata per questa entità." };
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const stimaPrezzoTool = tool({
  description:
    "Stima il PREZZO DI AGGIUDICAZIONE atteso di una gara: trova gare aggiudicate semanticamente simili e applica la distribuzione del ribasso (base d'asta → importo aggiudicato) alla base data. Usalo per domande tipo 'a quanto si aggiudica di solito una fornitura di guanti da 130k?' o 'quanto vale questa gara'. Passa il cig (se esiste) oppure descrizione + importoBase. Ritorna ribasso mediano e p25/p75, e una stima con intervallo. NB: è statistica, non un prezzo certo; molte gare (affidamento diretto) hanno ribasso ~0.",
  inputSchema: z.object({
    cig: z.string().optional().describe("CIG di una gara esistente (ne usa oggetto e base d'asta)."),
    descrizione: z.string().optional().describe("Descrizione della fornitura/servizio, se non c'è un CIG."),
    importoBase: z.number().optional().describe("Base d'asta in euro (per calcolare la stima)."),
  }),
  execute: async ({ cig, descrizione, importoBase }) => {
    try {
      return await stimaPrezzo({ cig, descrizione, importoBase });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const gareTemaTool = tool({
  description:
    "Classifica e CONTA le gare per TEMA in modo semantico (per significato), usando gli embedding su tutto il dataset. Usalo per domande tipo 'quante gare sanitarie ci sono', 'gare nel tema edilizia/IT/trasporti'. È più preciso del cercare parole chiave nell'oggetto (cattura i sinonimi: per 'sanitario' trova anche farmaci, presidi, parafarmaco; niente falsi positivi). Ritorna il totale e alcuni esempi. soglia: 0.55 ampio (default), 0.60 stretto, 0.65 solo i più centrati.",
  inputSchema: z.object({
    tema: z.string().describe("Descrizione del tema in linguaggio naturale, es. 'forniture sanitarie, dispositivi medici, farmaci'."),
    soglia: z.number().optional().describe("Soglia di similarità coseno 0-1 (default 0.55)."),
    soloAperti: z.boolean().optional().describe("Solo gare aperte (scadenza futura, non aggiudicate)."),
  }),
  execute: async ({ tema, soglia, soloAperti }) => {
    try {
      const r = await gareTema(tema, { soglia, soloAperti });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const metricheTool = tool({
  description: `Calcola una metrica aggregata sul grafo Neo4j e la mostra come GRAFICO all'utente. Usalo quando la domanda chiede una distribuzione, un confronto, una classifica o un andamento che ha senso visualizzare (es. "spesa per categoria", "gare per mese", "top enti per importo", "% per tipo di procedura").
Scrivi una query Cypher di SOLA LETTURA che restituisce poche righe (max ~20) con DUE colonne: una etichetta (stringa) e un valore (numero). Es: MATCH (l:Lotto) WHERE l.natura IS NOT NULL RETURN l.natura AS categoria, count(*) AS n ORDER BY n DESC.
Stesso schema/regole di queryGrafo (Ente-[:BANDISCE]->Lotto<-[:VINCE]-Impresa; Lotto-[:HA_CPV]->Cpv; importi possono essere null/outlier). Scegli tipo: "bar" (confronti/classifiche), "line" (andamento temporale), "pie" (composizione su poche voci). NON usare metriche quando l'utente chiede una "rete"/"grafo"/"network" di relazioni: in quel caso usa reteEntita.`,
  inputSchema: z.object({
    cypher: z.string().describe("Cypher read-only che ritorna righe con una colonna etichetta (string) e una valore (number)."),
    tipo: z.enum(["bar", "line", "pie"]).describe("Tipo di grafico."),
    titolo: z.string().describe("Titolo breve del grafico."),
    params: z.record(z.string(), z.any()).optional(),
  }),
  execute: async ({ cypher, tipo, titolo, params }) => {
    try {
      const { columns, rows } = await readCypher(cypher, params ?? {});
      return { ok: true, titolo, tipo, columns, rowCount: rows.length, rows: rows.slice(0, 20) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai(MODEL),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools: {
      risolviEntita: risolviEntitaTool,
      schemaGrafo: schemaGrafoTool,
      ricercaSemantica: ricercaSemanticaTool,
      dettaglioBando: dettaglioBandoTool,
      gareTema: gareTemaTool,
      reteEntita: reteEntitaTool,
      stimaPrezzo: stimaPrezzoTool,
      metriche: metricheTool,
      queryGrafo,
      cercaWeb: openai.tools.webSearch({}),
    },
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: { reasoningSummary: "auto", reasoningEffort: "medium" },
    },
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
