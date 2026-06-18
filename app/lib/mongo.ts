import { MongoClient, type Db } from "mongodb";

let client: MongoClient | null = null;
let dbInstance: Db | null = null;

function getDb(): Db {
  if (!dbInstance) {
    client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017");
    dbInstance = client.db(process.env.MONGODB_DB ?? "garagraph");
  }
  return dbInstance;
}

export type DettaglioBando = {
  cig: string;
  stato: string;
  aperto: boolean;
  oggetto: string | null;
  natura: string | null;
  cpv: unknown;
  importoBase: number | null;
  procedura: string | null;
  luogo: unknown;
  dataPubblicazione: string | null;
  dataScadenza: string | null;
  stazioneAppaltante: unknown;
  aggiudicazioni: unknown[];
  avvisi: unknown[];
  rettifiche: unknown[];
  link: { piattaforma: string | null; ted: string | null } | null;
  fonti: unknown;
} | null;

/** Per una lista di CIG, ritorna base d'asta e importo aggiudicato (per il ribasso). */
export async function ribassiPerCigs(
  cigs: string[]
): Promise<{ cig: string; base: number; aggiudicato: number; procedura: string | null }[]> {
  if (!cigs.length) return [];
  const docs = await getDb()
    .collection("lotti")
    .find(
      { _id: { $in: cigs }, importoBase: { $gt: 0 }, "aggiudicazioni.0.importo": { $gt: 0 } } as Record<string, unknown>,
      { projection: { importoBase: 1, "aggiudicazioni.importo": 1, procedura: 1 } }
    )
    .toArray();
  return docs.map((d) => ({
    cig: d._id as unknown as string,
    base: d.importoBase as number,
    aggiudicato: (d.aggiudicazioni as { importo: number }[])[0].importo,
    procedura: (d.procedura as string) ?? null,
  }));
}

/** Documento canonico completo di un bando, dato il CIG (Mongo `lotti`). */
export async function dettaglioBando(cig: string): Promise<DettaglioBando> {
  const doc = await getDb()
    .collection("lotti")
    .findOne(
      { _id: cig.trim().toUpperCase() } as Record<string, unknown>,
      {
        // Escludo l'embedding (pesante e inutile in risposta).
        projection: {
          embedding: 0,
          _embedText: 0,
          _embedDim: 0,
          _embedModel: 0,
          _embeddedAt: 0,
        },
      }
    );
  if (!doc) return null;

  // Stato derivato (server-side = unica verità per chat e UI).
  const scad = typeof doc.dataScadenza === "string" ? doc.dataScadenza : null;
  const aggiudicato = Array.isArray(doc.aggiudicazioni) && doc.aggiudicazioni.length > 0;
  const oggi = new Date().toISOString().slice(0, 10);
  const aperto = !aggiudicato && scad != null && scad >= oggi;
  const stato = aggiudicato
    ? "aggiudicato"
    : scad && scad >= oggi
      ? "aperto"
      : scad
        ? "scaduto"
        : "concluso/non datato";

  return {
    cig: (doc.cig as string) ?? (doc._id as unknown as string),
    stato,
    aperto,
    oggetto: doc.oggetto ?? null,
    natura: doc.natura ?? null,
    cpv: doc.cpv ?? null,
    importoBase: doc.importoBase ?? null,
    procedura: doc.procedura ?? null,
    luogo: doc.luogo ?? null,
    dataPubblicazione: doc.dataPubblicazione ?? null,
    dataScadenza: doc.dataScadenza ?? null,
    stazioneAppaltante: doc.stazioneAppaltante ?? null,
    aggiudicazioni: doc.aggiudicazioni ?? [],
    avvisi: doc.avvisi ?? [],
    rettifiche: doc.rettifiche ?? [],
    link: doc.link ?? null,
    fonti: doc._sources ?? null,
  };
}
