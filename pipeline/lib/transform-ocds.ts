// Trasforma una release OCDS (raw_ocds_releases) in una `OcdsSyncRow`.
// Riusa normalizeCf / normalizeDenominazione di transform.ts.
//
// Mappa:
//   release.id          → idAvviso (sintetico)
//   release.ocid        → idAppalto
//   release.buyer       → SA (con CF da buyer.id, riconciliato con parties[].identifier)
//   release.parties[]   → soggetti completi (con address, roles)
//   release.awards[]    → aggiudicatari + importi
//   release.tender.items[].classification.id  →  CPV (multipli, deduplicati)
//   release.tender.lots[].id (primo)          →  CIG (più CIG per release nel caso multi-lotto)
//   release.tender.mainProcurementCategory    →  natura
//   release.tender.procurementMethodDetails   →  modalità (parsed)

import { normalizeCf, normalizeDenominazione } from "./transform";

export type OcdsSoggetto = {
  cf: string;
  denominazione: string;
  denominazioneNormalizzata: string;
};

export type OcdsAggiudicatario = OcdsSoggetto & { importo: number | null };

export type OcdsSyncRow = {
  idAvviso: string;
  codiceScheda: string;
  tipo: "avviso";
  dataPubblicazione: string | null;
  attivo: boolean;
  oscurato: boolean;
  tags: string[];

  idAppalto: string;
  cig: string | null;
  oggetto: string | null;
  natura: string | null;
  modalita: string;

  saList: OcdsSoggetto[];
  aggiudicatari: OcdsAggiudicatario[];
  cpvCodici: string[];
};

type Party = {
  id?: string;
  name?: string;
  identifier?: { id?: string; scheme?: string; legalName?: string };
  roles?: string[];
};

type Award = {
  status?: string;
  date?: string;
  value?: { amount?: number };
  suppliers?: Array<{ id?: string; name?: string }>;
};

type Tender = {
  description?: string;
  mainProcurementCategory?: string;
  procurementMethodDetails?: string;
  lots?: Array<{ id?: string }>;
  items?: Array<{
    classification?: { id?: string; scheme?: string; description?: string };
  }>;
};

type OcdsRelease = {
  id: string;
  ocid: string;
  date?: string;
  tag?: string[];
  buyer?: { id?: string; name?: string };
  parties?: Party[];
  awards?: Award[];
  tender?: Tender;
};

export function parseOcdsModalita(detail: string | undefined): string {
  if (!detail) return "altro";
  const u = detail.toUpperCase();
  if (u.includes("AFFIDAMENTO DIRETTO")) return "diretto";
  if (u.includes("PROCEDURA APERTA")) return "aperta";
  if (u.includes("PROCEDURA NEGOZIATA")) return "negoziata";
  if (u.includes("PROCEDURA RISTRETTA")) return "ristretta";
  if (u.includes("DIALOGO COMPETITIVO")) return "dialogo";
  if (u.includes("ACCORDO QUADRO")) return "accordo_quadro";
  if (u.includes("AFFIDAMENTO IN ECONOMIA")) return "economia";
  return "altro";
}

export function parseOcdsDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const direct = new Date(raw);
  if (!isNaN(direct.getTime())) return direct.toISOString();
  // ANAC sometimes emits malformed strings like "2025-07-18 16:32:28.200T12:00:00Z"
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
  if (m) {
    const iso = m[2] ? `${m[1]}T${m[2]}Z` : `${m[1]}T00:00:00Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function syntheticCodiceScheda(tags: string[]): string {
  // Map OCDS tag combinations to a synthetic code, stays under our codiceScheda axis.
  const has = (t: string) => tags.includes(t);
  if (has("award") && has("contract")) return "OCDS-AC";
  if (has("award")) return "OCDS-A";
  if (has("tender") && has("award")) return "OCDS-TA";
  if (has("tender")) return "OCDS-T";
  if (has("contract")) return "OCDS-C";
  if (has("planning")) return "OCDS-P";
  return "OCDS-X";
}

export function ocdsToSyncRow(rel: OcdsRelease): OcdsSyncRow | null {
  if (!rel.id || !rel.ocid) return null;

  // Stazione appaltante: prefer parties[] entry whose role includes 'buyer'
  const saList: OcdsSoggetto[] = [];
  const seenSa = new Set<string>();
  for (const p of rel.parties ?? []) {
    if (!p.roles?.includes("buyer")) continue;
    const cfRaw = p.identifier?.id ?? p.id;
    const cf = normalizeCf(cfRaw);
    const den = p.name ?? p.identifier?.legalName;
    if (!cf || !den || seenSa.has(cf)) continue;
    seenSa.add(cf);
    saList.push({
      cf,
      denominazione: den,
      denominazioneNormalizzata: normalizeDenominazione(den),
    });
  }
  // Fallback: top-level buyer if parties[] didn't yield anything
  if (saList.length === 0 && rel.buyer) {
    const cf = normalizeCf(rel.buyer.id);
    if (cf && rel.buyer.name) {
      saList.push({
        cf,
        denominazione: rel.buyer.name,
        denominazioneNormalizzata: normalizeDenominazione(rel.buyer.name),
      });
    }
  }

  // Aggiudicatari: walk awards[] then suppliers[]; cross-check parties[] for CF if not in supplier
  const partyByName = new Map<string, Party>();
  const partyById = new Map<string, Party>();
  for (const p of rel.parties ?? []) {
    if (p.id) partyById.set(p.id, p);
    if (p.name) partyByName.set(p.name, p);
  }
  const aggiudicatari: OcdsAggiudicatario[] = [];
  for (const aw of rel.awards ?? []) {
    if (aw.status && aw.status !== "active") continue;
    const importo =
      typeof aw.value?.amount === "number" ? aw.value!.amount! : null;
    for (const s of aw.suppliers ?? []) {
      // Try CF from supplier.id; fallback to parties[].identifier.id matching by name/id
      let cf = normalizeCf(s.id);
      const den = s.name ?? partyById.get(s.id ?? "")?.name;
      if (!cf) {
        const party = s.id ? partyById.get(s.id) : undefined;
        cf = normalizeCf(party?.identifier?.id ?? party?.id);
      }
      if (!cf || !den) continue;
      aggiudicatari.push({
        cf,
        denominazione: den,
        denominazioneNormalizzata: normalizeDenominazione(den),
        importo,
      });
    }
  }

  // CPVs (dedup; skip placeholder "99999999")
  const cpvCodici: string[] = [];
  const seenCpv = new Set<string>();
  for (const item of rel.tender?.items ?? []) {
    const code = item.classification?.id;
    if (!code) continue;
    if (code === "99999999") continue;
    if (seenCpv.has(code)) continue;
    seenCpv.add(code);
    cpvCodici.push(code);
  }

  // CIG: use first lot id (multi-lot release loses extras here — accettato per F4)
  const cig = rel.tender?.lots?.[0]?.id?.trim() || null;

  const tags = Array.isArray(rel.tag) ? rel.tag : [];

  return {
    idAvviso: rel.id,
    codiceScheda: syntheticCodiceScheda(tags),
    tipo: "avviso",
    dataPubblicazione: parseOcdsDate(rel.date),
    attivo: true,
    oscurato: false,
    tags,

    idAppalto: rel.ocid,
    cig,
    oggetto: rel.tender?.description ?? null,
    natura: rel.tender?.mainProcurementCategory ?? null,
    modalita: parseOcdsModalita(rel.tender?.procurementMethodDetails),

    saList,
    aggiudicatari,
    cpvCodici,
  };
}
