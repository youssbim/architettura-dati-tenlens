import type { AvvisoDetail } from "./anac";

export type Soggetto = {
  codiceFiscale?: string;
  denominazione?: string;
};

export type AggiudicatarioEntry = {
  importo?: number;
  soggetti: Soggetto[];
};

export type Summary = {
  stazioneAppaltante: Soggetto[];
  aggiudicatari: AggiudicatarioEntry[];
  cig?: string;
  cup?: string;
  oggetto?: string;
  natura?: string;
  importoTotale?: number;
  luogo?: string;
  documenti?: string;
};

type Loose = Record<string, unknown>;
function asObj(v: unknown): Loose | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Loose)
    : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

export function extractSummary(d: AvvisoDetail): Summary {
  const out: Summary = { stazioneAppaltante: [], aggiudicatari: [] };

  const tpl = (d.template as unknown[] | undefined)?.[0] as Loose | undefined;
  const inner = asObj(tpl?.template) ?? {};
  const metadata = asObj(inner.metadata);
  out.oggetto = asStr(metadata?.titolo) ?? asStr(metadata?.descrizione);

  for (const rawSec of asArr(inner.sections)) {
    const sec = asObj(rawSec);
    if (!sec) continue;

    // Section A — fields.soggetti_sa[]
    const fields = asObj(sec.fields);
    if (fields) {
      for (const rawSa of asArr(fields.soggetti_sa)) {
        const sa = asObj(rawSa);
        if (!sa) continue;
        out.stazioneAppaltante.push({
          codiceFiscale: asStr(sa.codice_fiscale),
          denominazione:
            asStr(sa.denominazione_amministrazione) ??
            asStr(sa.denominazione),
        });
      }
      out.documenti ??= asStr(fields.documenti_di_gara_link);
    }

    // Section C — items[]
    for (const rawItem of asArr(sec.items)) {
      const it = asObj(rawItem);
      if (!it) continue;
      out.cig ??= asStr(it.cig);
      out.cup ??= asStr(it.cup);
      out.oggetto ??= asStr(it.descrizione);
      out.natura ??= asStr(it.natura_principale);
      out.luogo ??= asStr(it.luogo_istat);
      out.importoTotale ??=
        asNum(it.valore_affidamento) ??
        asNum(it.valore_totale) ??
        asNum(it.importo);
      out.documenti ??= asStr(it.documenti_di_gara_link);

      for (const rawAg of asArr(it.aggiudicatari_ad)) {
        const ag = asObj(rawAg);
        if (!ag) continue;
        const soggetti = asArr(ag.soggetti)
          .map(asObj)
          .filter((s): s is Loose => !!s)
          .map((s) => ({
            codiceFiscale: asStr(s.codice_fiscale),
            denominazione: asStr(s.denominazione),
          }));
        out.aggiudicatari.push({
          importo: asNum(ag.importo),
          soggetti,
        });
      }
    }
  }

  return out;
}

const eur = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 2,
});

export function fmtEur(n: number | undefined | null): string {
  if (n == null) return "—";
  return eur.format(n);
}

// Pretty-print arbitrary leaf values for the generic section renderer.
export function fmtScalar(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "sì" : "no";
  if (typeof v === "number") return v.toLocaleString("it-IT");
  if (typeof v === "string") {
    // ISO date heuristic
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString("it-IT");
    }
    return v;
  }
  return JSON.stringify(v);
}

// Friendlier label for snake_case keys, e.g. "valore_affidamento" → "Valore affidamento"
export function humanize(key: string): string {
  return key
    .replace(/[_-]/g, " ")
    .replace(/\b(\w)/g, (m) => m.toUpperCase());
}
