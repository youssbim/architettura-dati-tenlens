// ② NORMALIZE (OCDS) — una release OCDS → N Contributi (uno per CIG).
// Stesso output dell'adapter PL (`Contributo[]`): è qui che si realizza
// l'agnosticità dalla fonte — PL e OCDS convergono nella stessa forma canonica.
// Vedi docs/schema.md §C per la mappatura dei campi.

import { normalizeCf } from "./transform";
import type { Contributo, Aggiudicazione, SoggettoRef, Natura } from "./model";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rel = any;

const NAT: Record<string, Natura> = { works: "Lavori", services: "Servizi", goods: "Forniture" };
const amt = (v: any): number | null => (v?.amount != null ? Number(v.amount) : null);
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : null);
// `roles` arriva come stringa ("buyer") o array (["buyer","payer"])
const rolesOf = (p: any): string[] => (Array.isArray(p?.roles) ? p.roles : typeof p?.roles === "string" ? p.roles.split(/[;,\s]+/) : []);
const cfOf = (p: any) => normalizeCf(p?.identifier?.id);

function partySA(parties: any[]): SoggettoRef | null {
  const b = parties.find((p) => rolesOf(p).includes("buyer"));
  if (!b) return null;
  const cf = cfOf(b);
  return cf ? { cf, denominazione: String(b.name || "") } : null;
}

function methodOf(t: any): string | null {
  const d = t?.procurementMethodDetails;
  if (typeof d === "string") { const m = d.match(/TITLE:(.+)$/); return (m ? m[1] : d).trim().toLowerCase() || null; }
  return t?.procurementMethod ?? null;
}

function stadioOf(tag: any): "tender" | "award" | "amendment" {
  const tags = (Array.isArray(tag) ? tag : [tag]).map((x) => String(x));
  if (tags.some((x) => /award/i.test(x))) return "award";
  if (tags.some((x) => /amendment|modif/i.test(x))) return "amendment";
  return "tender";
}

export function ocdsToContributi(rel: Rel): Contributo[] {
  const parties: any[] = rel.parties ?? [];
  const partyById = new Map(parties.map((p) => [String(p.id), p]));
  const sa = partySA(parties);
  const t = rel.tender ?? {};
  const data = d10(rel.date);
  const stadio = stadioOf(rel.tag);
  const procedura = methodOf(t);
  const natura = NAT[t.mainProcurementCategory] ?? null;
  const avviso = {
    idAvviso: String(rel.id),
    codiceScheda: Array.isArray(rel.tag) ? rel.tag.join("+") : String(rel.tag ?? ""),
    tipo: "ocds",
    data,
    fonte: "ocds" as const,
    nuovoAvviso: null,
  };

  // indicizza gli award per CIG (via relatedLots / items[].relatedLot)
  const awardByCig = new Map<string, any>();
  for (const aw of rel.awards ?? []) {
    const cigs = [...(aw.relatedLots ?? []), ...((aw.items ?? []).map((i: any) => i.relatedLot || i.id))];
    for (const c of cigs) if (c) awardByCig.set(String(c), aw);
  }
  const aggsFor = (cig: string): Aggiudicazione[] => {
    const aw = awardByCig.get(cig);
    if (!aw) return [];
    // suppliers: dai riferimenti dell'award (risolti sulle parties), altrimenti parties[role=supplier]
    let sup: any[] = (aw.suppliers ?? []).map((s: any) => partyById.get(String(s.id)) ?? s);
    if (sup.length === 0) sup = parties.filter((p) => rolesOf(p).includes("supplier"));
    return sup
      .map((s) => ({ impresa: { cf: cfOf(s) || "", denominazione: String(s.name || "") }, importo: amt(aw.value), data: d10(aw.date), esito: aw.status ?? null }))
      .filter((a) => a.impresa.cf);
  };

  const items: any[] = t.items ?? [];
  const out: Contributo[] = [];
  const seen = new Set<string>();
  const push = (cig: string, oggetto: string | null, importo: number | null, cpv: string[]) => {
    if (!cig || seen.has(cig)) return;
    seen.add(cig);
    out.push({
      cig, fonte: "ocds", stadio, garaId: rel.ocid ?? null, avviso,
      oggetto: oggetto ?? t.description ?? null, natura, cpv,
      importoBase: importo ?? amt(t.value) ?? null, procedura,
      luogo: { nuts: null, istat: null },
      dataPubblicazione: data, dataScadenza: d10(t.tenderPeriod?.endDate),
      stazioneAppaltante: sa, aggiudicazioni: aggsFor(cig),
    });
  };

  for (const it of items) {
    const cig = String(it.relatedLot || it.id || "");
    const cls = it.classification;
    const cpv = cls && cls.scheme === "CPV" && cls.id && cls.id !== "99999999" ? [String(cls.id)] : [];
    push(cig, it.description ?? null, amt(it.unit?.value), cpv);
  }
  // fallback: gare senza items espliciti → usa i lots
  if (out.length === 0) for (const lot of t.lots ?? []) push(String(lot.id || ""), lot.description ?? null, amt(lot.value), []);

  return out;
}
