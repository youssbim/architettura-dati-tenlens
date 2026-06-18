// ② NORMALIZE (Pubblicità Legale) — un avviso PL → N Contributi (uno per CIG).
// Gestisce le varianti di campo per famiglia di scheda (es. aggiudicatario in
// `aggiudicatari` per le gare A*, `aggiudicatari_ad` per l'affidamento AD3).
// Vedi docs/schema.md §C.

import { normalizeCf } from "./transform";
import type { Contributo, Aggiudicazione, SoggettoRef, Natura } from "./model";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = any;

function sezioni(doc: Doc) {
  const tpl = doc?.template?.[0]?.template ?? {};
  const sections: any[] = tpl.sections ?? [];
  const find = (p: string) => sections.find((s) => String(s?.name || "").startsWith(p));
  return { meta: tpl.metadata ?? {}, A: find("SEZ. A"), B: find("SEZ. B"), C: find("SEZ. C") };
}

function saFrom(A: any): SoggettoRef | null {
  if (!A) return null;
  const f = A.fields || {};
  let cf = f.codice_fiscale_sa as string | undefined;
  let den = f.denominazione_sa as string | undefined;
  if ((!cf || !den) && Array.isArray(f.soggetti_sa) && f.soggetti_sa[0]) {
    cf = cf || f.soggetti_sa[0].codice_fiscale;
    den = den || f.soggetti_sa[0].denominazione_amministrazione;
  }
  const ncf = normalizeCf(cf);
  if (!ncf || !den) return null;
  return { cf: ncf, denominazione: String(den) };
}

function aggsFrom(item: any): Aggiudicazione[] {
  const raw: any[] = item.aggiudicatari || item.aggiudicatari_ad || [];
  const out: Aggiudicazione[] = [];
  for (const a of raw) {
    for (const s of a.soggetti || []) {
      const cf = normalizeCf(s.codice_fiscale);
      if (!cf) continue;
      out.push({
        impresa: { cf, denominazione: String(s.denominazione || "") },
        importo: a.importo ?? item.valore_offerta_vincente ?? item.valore_affidamento ?? null,
        data: null,
        esito: null,
      });
    }
  }
  return out;
}

function stadioOf(cs: string | null, hasAgg: boolean): "tender" | "award" | "amendment" {
  if (cs?.startsWith("M")) return "amendment";
  if (hasAgg) return "award";
  return "tender";
}

const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : null);

export function plToContributi(doc: Doc): Contributo[] {
  const { meta, A, B, C } = sezioni(doc);
  const sa = saFrom(A);
  const cs: string | null = doc.codiceScheda ?? null;
  const procedura = cs?.startsWith("AD3")
    ? "affidamento_diretto"
    : (B?.fields?.tipo_procedura_aggiudicazione ?? null);
  const data = d10(doc.dataPubblicazione);
  const avviso = {
    idAvviso: doc.idAvviso,
    codiceScheda: cs,
    tipo: doc.tipo ?? null,
    data,
    fonte: "pl" as const,
    nuovoAvviso: doc.nuovoAvviso ?? null,
  };

  // Link utili: piattaforma di gara (dove consultare/partecipare) e avviso TED (UE).
  const isHttp = (v: unknown): string | null =>
    typeof v === "string" && /^https?:\/\//i.test(v) ? v : null;
  const tpl = doc?.template?.[0]?.template ?? {};
  const allSections: any[] = tpl.sections ?? [];
  const ted = isHttp(meta.link_eform_ted);
  const piattaformaSez =
    allSections.map((s) => isHttp(s?.fields?.documenti_di_gara_link)).find(Boolean) ?? null;

  const items: any[] = C?.items ?? [];
  const out: Contributo[] = [];
  for (const it of items) {
    if (!it.cig) continue;
    const aggiud = aggsFrom(it);
    const piattaforma = isHttp(it.documenti_di_gara_link) ?? piattaformaSez;
    out.push({
      cig: String(it.cig),
      fonte: "pl",
      stadio: stadioOf(cs, aggiud.length > 0),
      garaId: doc.idAppalto ?? null,
      avviso,
      oggetto: it.descrizione ?? meta.descrizione ?? null,
      natura: (it.natura_principale as Natura) ?? null,
      cpv: it.cpv ? [String(it.cpv)] : [],
      importoBase: it.valore_complessivo_stimato ?? it.valore_affidamento ?? null,
      procedura,
      luogo: { nuts: it.luogo_nuts ?? null, istat: it.luogo_istat ?? null },
      dataPubblicazione: data,
      dataScadenza: d10(doc.dataScadenza),
      stazioneAppaltante: sa,
      aggiudicazioni: aggiud,
      link: piattaforma || ted ? { piattaforma: piattaforma ?? null, ted: ted ?? null } : null,
    });
  }
  return out;
}
