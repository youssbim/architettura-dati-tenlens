// Modello canonico di Tenlens — il "contratto" tra gli stadi dell'ETL.
// Gli adapter (PL, OCDS) producono `Contributo`; il merge-by-CIG produce
// `CanonicalLotto`; la sync materializza il grafo. Vedi docs/schema.md.

export type Fonte = "pl" | "ocds";
export type Natura = "Lavori" | "Servizi" | "Forniture" | "Altro";

export type SoggettoRef = {
  cf: string; // codice fiscale normalizzato
  denominazione: string;
};

export type Aggiudicazione = {
  impresa: SoggettoRef;
  importo: number | null;
  data: string | null; // ISO date
  esito: string | null; // es. "active" | "cancelled"
};

export type AvvisoRef = {
  idAvviso: string;
  codiceScheda: string | null;
  tipo: string | null; // "avviso" | "rettifica"
  data: string | null; // ISO date
  fonte: Fonte;
  nuovoAvviso?: string | null; // catena rettifiche (idAvviso che lo sostituisce)
};

// Output dello stadio ② NORMALIZE: il contributo di UN documento a UN lotto.
// Più contributi sullo stesso `cig` vengono fusi (stadio ③) in un CanonicalLotto.
export type Contributo = {
  cig: string;
  fonte: Fonte;
  stadio: "tender" | "award" | "amendment"; // bando | esito | modifica/rettifica
  garaId: string | null; // idAppalto (PL) o ocid (OCDS)
  avviso: AvvisoRef;
  oggetto?: string | null;
  natura?: Natura | null;
  cpv?: string[];
  importoBase?: number | null;
  procedura?: string | null;
  luogo?: { nuts?: string | null; istat?: string | null };
  dataPubblicazione?: string | null;
  dataScadenza?: string | null;
  stazioneAppaltante?: SoggettoRef | null;
  aggiudicazioni?: Aggiudicazione[];
  link?: { piattaforma: string | null; ted: string | null } | null;
};

// Output dello stadio ③ MERGE: il record canonico per CIG (collezione `lotti`).
export type CanonicalLotto = {
  _id: string; // = cig
  cig: string;
  garaId: { pl?: string | null; ocds?: string | null };
  oggetto: string | null;
  natura: Natura | null;
  cpv: string[];
  importoBase: number | null;
  procedura: string | null;
  luogo: { nuts: string | null; istat: string | null };
  dataPubblicazione: string | null;
  dataScadenza: string | null;
  stazioneAppaltante: SoggettoRef | null;
  aggiudicazioni: Aggiudicazione[];
  avvisi: AvvisoRef[];
  rettifiche: { idAvviso: string; rifAvviso: string | null; data: string | null }[];
  link: { piattaforma: string | null; ted: string | null } | null;
  _sources: Fonte[];
  _firstSeenAt: Date;
  _updatedAt: Date;
};

// Etichette/relazioni del grafo (per riferimento negli script di sync).
export const NODE_LABELS = ["Soggetto", "Impresa", "StazioneAppaltante", "Lotto", "Avviso", "Cpv"] as const;
export const REL_TYPES = [
  "HA_PUBBLICATO",
  "RIGUARDA",
  "AGGIUDICATO_A",
  "HA_CPV",
  "RETTIFICA",
  "STESSO_SOGGETTO",
  "POSSIBILE_DUPLICATO",
] as const;
