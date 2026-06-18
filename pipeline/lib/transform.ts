// Trasforma un documento raw_avvisi (payload ANAC verbatim) in una `SyncRow`
// piatta, pronta per le UNWIND...MERGE Cypher di sync-graph.ts.
//
// Riusa la logica di extract.ts per i campi business e aggiunge:
//   - normalizzazione del CF (L1 record linkage)
//   - normalizzazione della denominazione
//   - tagging della modalità (diretto/gara/...)
//
// Documenti senza CF della SA o senza aggiudicatari sono comunque processati:
// si materializza l'Avviso/Appalto, ma le relazioni mancanti si saltano.

import { extractSummary } from "./extract";
import { modalitaFor, type Modalita } from "./codici-scheda";
import type { AvvisoDetail } from "./anac";

export type SoggettoRow = {
  cf: string;
  denominazione: string;
  denominazioneNormalizzata: string;
};

export type AggiudicatarioRow = SoggettoRow & {
  importo: number | null;
};

export type SyncRow = {
  // Avviso
  idAvviso: string;
  codiceScheda: string;
  tipo: string;
  dataPubblicazione: string;
  attivo: boolean;
  oscurato: boolean;
  nuovoAvviso: string | null;

  // Appalto
  idAppalto: string;
  cig: string | null;
  oggetto: string | null;
  natura: string | null;
  luogo: string | null;
  modalita: Modalita;

  // Relazioni
  saList: SoggettoRow[];
  aggiudicatari: AggiudicatarioRow[];
};

// Normalizza un codice fiscale: trim, upper, strip "IT" prefix.
// Per partite IVA italiane di 11 cifre o CF di 16 caratteri.
// Ritorna null se il valore non è plausibile come CF/P.IVA.
export function normalizeCf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase().replace(/^IT/, "").replace(/\s+/g, "");
  if (v.length === 0) return null;
  if (!/^[0-9A-Z]+$/.test(v)) return null;
  if (v.length < 8 || v.length > 16) return null;
  return v;
}

// Normalizza una denominazione per il fuzzy matching (L2/L3).
// - lowercase
// - rimuove suffissi societari comuni
// - rimuove punteggiatura
// - collassa spazi
export function normalizeDenominazione(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(
      /\b(s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|s\.?c\.?r\.?l\.?|s\.?c\.?p\.?a\.?|scarl|coop\.?|cooperativa|s\.?\s*coop\.?)\b/g,
      "",
    )
    .replace(/[^a-z0-9àèéìòù\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSyncRow(doc: AvvisoDetail): SyncRow | null {
  if (!doc.idAvviso || !doc.idAppalto) return null;

  const summary = extractSummary(doc);
  const codiceScheda = doc.codiceScheda ?? "";

  const saList: SoggettoRow[] = [];
  for (const sa of summary.stazioneAppaltante) {
    const cf = normalizeCf(sa.codiceFiscale);
    if (!cf || !sa.denominazione) continue;
    saList.push({
      cf,
      denominazione: sa.denominazione,
      denominazioneNormalizzata: normalizeDenominazione(sa.denominazione),
    });
  }

  const aggiudicatari: AggiudicatarioRow[] = [];
  for (const ag of summary.aggiudicatari) {
    for (const s of ag.soggetti) {
      const cf = normalizeCf(s.codiceFiscale);
      if (!cf || !s.denominazione) continue;
      aggiudicatari.push({
        cf,
        denominazione: s.denominazione,
        denominazioneNormalizzata: normalizeDenominazione(s.denominazione),
        importo: ag.importo ?? null,
      });
    }
  }

  return {
    idAvviso: doc.idAvviso,
    codiceScheda,
    tipo: doc.tipo ?? "avviso",
    dataPubblicazione: doc.dataPubblicazione ?? "",
    attivo: doc.attivo ?? true,
    oscurato: doc.oscurato ?? false,
    nuovoAvviso: doc.nuovoAvviso ?? null,

    idAppalto: doc.idAppalto,
    cig: summary.cig ?? null,
    oggetto: summary.oggetto ?? null,
    natura: summary.natura ?? null,
    luogo: summary.luogo ?? null,
    modalita: modalitaFor(codiceScheda),

    saList,
    aggiudicatari,
  };
}
