// Mappa codiceScheda → (sezione, label).
// Estratta dal bundle Angular di pubblicitalegale.anticorruzione.it
// (case-switch su ~74 codici, raggruppati in 11 template eForm).
// Codici non in lista cadono nel default: section "unmapped".
//
// Asse 1 — `tipo` JSON: avviso (prima pubblicazione) | rettifica (correzione legale)
// Asse 2 — `codiceScheda`: template eForm in una di 3 sezioni del portale ANAC.

export type Sezione = "bandi" | "avvisi" | "esiti" | "?";

type SchedaInfo = { sezione: Sezione; label: string };

function expand(codes: string[], info: SchedaInfo): Record<string, SchedaInfo> {
  return Object.fromEntries(codes.map((c) => [c, info]));
}

const TEMPLATE: Record<string, SchedaInfo> = {
  // template 1 — avvisi · preinformazione fini informativi
  ...expand(
    [
      "PL1_1", "PL1_2", "PL1_3", "PL1_4", "PL1_5",
      "PL1_6", "PL1_7", "PL1_8", "PL1_9",
      "PL2_1", "PL2_2", "PL2_3", "PL2_7", "PL2_8", "PL2_9",
    ],
    { sezione: "avvisi", label: "Preinformazione" },
  ),
  // template 2 — bandi · pre-informazione fini indittivi
  ...expand(
    ["P1_10", "P1_11", "P1_12", "P1_13", "P1_14",
     "P2_10", "P2_11", "P2_12", "P2_13", "P2_14"],
    { sezione: "bandi", label: "Bando di gara" },
  ),
  // template 3 — avvisi · sistema di qualificazione
  ...expand(["P1_15_1", "P1_15_2"], {
    sezione: "avvisi",
    label: "Sistema di qualificazione",
  }),
  // template 5a/5b — avvisi · indagine di mercato
  ...expand(["P7_1_1", "P7_1_2", "P7_1_3"], {
    sezione: "avvisi",
    label: "Indagine di mercato",
  }),
  // template 6 — avvisi · elenchi operatori economici
  P7_3: { sezione: "avvisi", label: "Elenco operatori economici" },
  // template 7 — esiti · risultati (avviso di aggiudicazione)
  ...expand(
    [
      "A1_29", "A1_30", "A1_31", "A1_32", "A1_33", "A1_34", "A1_35", "A1_36", "A1_37",
      "A2_29", "A2_30", "A2_31", "A2_32", "A2_33", "A2_34", "A2_35", "A2_36", "A2_37",
      "A3_4", "A3_5",
      "A4_1", "A4_2", "A4_3", "A4_4", "A4_5", "A4_6",
      "A7_1_2",
      "AD2_25", "AD2_26", "AD2_27", "AD2_28",
      "NAG",
    ],
    { sezione: "esiti", label: "Avviso di aggiudicazione" },
  ),
  // template 8a — esiti · affidamento diretto
  AD3: { sezione: "esiti", label: "Esito affidamento diretto" },
  // template 8b — avvisi · affidamento diretto
  A3_6: { sezione: "avvisi", label: "Avviso affidamento diretto" },
  // template 9 — esiti · trasparenza preventiva
  ...expand(["A7_1_1", "AD1_25", "AD1_26", "AD1_27", "AD1_28"], {
    sezione: "esiti",
    label: "Trasparenza preventiva",
  }),
  // template 10 — avvisi · modifica del contratto
  ...expand(["M1", "M1_40", "M2", "M2_40"], {
    sezione: "avvisi",
    label: "Modifica del contratto",
  }),
};

export function labelFor(codice: string | null | undefined): string {
  if (!codice) return "—";
  return TEMPLATE[codice]?.label ?? `Scheda ${codice}`;
}

export function sezioneFor(codice: string | null | undefined): Sezione {
  if (!codice) return "?";
  return TEMPLATE[codice]?.sezione ?? "?";
}

export type Modalita =
  | "diretto"
  | "gara"
  | "trasparenza"
  | "modifica"
  | "preinformazione"
  | "qualificazione"
  | "indagine"
  | "elenco"
  | "altro";

// Classifica il codice scheda in macro-modalità, usata come tag sugli archi del grafo.
export function modalitaFor(codice: string | null | undefined): Modalita {
  if (!codice) return "altro";
  const info = TEMPLATE[codice];
  if (!info) return "altro";
  const l = info.label.toLowerCase();
  if (l.includes("diretto")) return "diretto";
  if (l.includes("aggiudicazione")) return "gara";
  if (l.includes("trasparenza")) return "trasparenza";
  if (l.includes("modifica del contratto")) return "modifica";
  if (l.includes("preinformazione")) return "preinformazione";
  if (l.includes("qualificazione")) return "qualificazione";
  if (l.includes("indagine di mercato")) return "indagine";
  if (l.includes("elenco operatori")) return "elenco";
  if (l.includes("bando")) return "gara";
  return "altro";
}
