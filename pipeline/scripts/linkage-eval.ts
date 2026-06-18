// Banco di prova per il record linkage: confronta diverse strategie sulla
// stessa verità (scripts/data/goldset.csv) e ne misura precision / recall / F1.
//
// Una "strategia" è una funzione coppia → same|diff. Le confrontiamo per
// trovare un buon compromesso tra precisione (non unire enti distinti) e
// recall (recuperare i duplicati veri: refusi del CF e ditte individuali
// presenti con CF persona + P.IVA).
//
// Uso: npm run linkage:eval

import { readFile } from "node:fs/promises";
import path from "node:path";
import { cfRelation, linkVerdict } from "../lib/cf";

const CSV = process.env.GOLD_CSV
  ? path.resolve(process.env.GOLD_CSV)
  : path.join(process.cwd(), "scripts", "data", "goldset.csv");

type Pair = {
  id: string;
  leftCf: string;
  rightCf: string;
  leftNorm: string;
  rightNorm: string;
  nameEdit: number;
  nameRel: number;
  truth: "same" | "diff";
  den: string;
};

// candidato del matcher di nome attuale (ciò che genererebbe L2 o L3)
function isNameCandidate(p: Pair): boolean {
  if (p.leftNorm === p.rightNorm) return true; // L2
  const minLen = Math.min(p.leftNorm.length, p.rightNorm.length);
  return p.nameEdit >= 1 && p.nameEdit <= 2 && p.nameRel <= 0.2 && minLen >= 8; // L3
}
const despace = (s: string) => s.replace(/\s+/g, "");

type Strategy = { name: string; predict: (p: Pair) => "same" | "diff" };

const STRATEGIES: Strategy[] = [
  {
    name: "S1 · L2 solo (nome esatto)",
    predict: (p) => (p.leftNorm === p.rightNorm ? "same" : "diff"),
  },
  {
    name: "S2 · L2+L3 nome (ATTUALE)",
    predict: (p) => (isNameCandidate(p) ? "same" : "diff"),
  },
  {
    name: "S3 · nome + gate CF",
    // accetta il match sul nome, MA rifiuta se il CF prova enti distinti
    predict: (p) => (isNameCandidate(p) && cfRelation(p.leftCf, p.rightCf) !== "diff" ? "same" : "diff"),
  },
  {
    name: "S4 · CF-first (bridge solo a nome identico)",
    // refusi sempre; bridge CF-persona↔P.IVA solo se la denominazione è identica
    predict: (p) => {
      const rel = cfRelation(p.leftCf, p.rightCf);
      if (rel === "same") return "same";
      if (rel === "inconclusive" && p.leftNorm === p.rightNorm) return "same";
      return "diff";
    },
  },
  {
    name: "S5 · solo CF (nessun nome)",
    predict: (p) => (cfRelation(p.leftCf, p.rightCf) === "same" ? "same" : "diff"),
  },
  {
    name: "S6 · nome + gate CF + token (illustrativa*)",
    // come S3 ma sui bridge inconcludenti separa rumore (spazi/parola generica)
    // da differenze di token discriminante. *soglia tarata su pochi punti.
    predict: (p) => {
      if (!isNameCandidate(p)) return "diff";
      const rel = cfRelation(p.leftCf, p.rightCf);
      if (rel === "diff") return "diff";
      if (rel === "same") return "same";
      // inconclusive (CF persona vs P.IVA): accetta solo se la differenza è "rumore"
      if (p.leftNorm === p.rightNorm) return "same";
      if (despace(p.leftNorm) === despace(p.rightNorm)) return "same";
      return p.nameRel <= 0.03 ? "same" : "diff";
    },
  },
  {
    name: "S7 · COMPROMESSO a livelli (merge+bridge)",
    // auto-merge solo merge/bridge; i 'review' restano sospesi (non uniti)
    predict: (p) => {
      if (!isNameCandidate(p)) return "diff";
      return linkVerdict(p.leftCf, p.rightCf, p.leftNorm, p.rightNorm).same ? "same" : "diff";
    },
  },
];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

function metrics(pairs: Pair[], s: Strategy) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const fpIds: string[] = [];
  const fnIds: string[] = [];
  for (const p of pairs) {
    const pred = s.predict(p);
    if (pred === "same" && p.truth === "same") tp++;
    else if (pred === "same" && p.truth === "diff") { fp++; fpIds.push(p.id); }
    else if (pred === "diff" && p.truth === "same") { fn++; fnIds.push(p.id); }
    else tn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 1;
  const rec = tp + fn ? tp / (tp + fn) : 1;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  return { tp, fp, fn, tn, prec, rec, f1, fpIds, fnIds };
}

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(CSV, "utf8"));
  const h = rows[0];
  const ix = (n: string) => h.indexOf(n);
  const pairs: Pair[] = rows.slice(1).map((r) => ({
    id: r[ix("id")],
    leftCf: r[ix("leftCf")],
    rightCf: r[ix("rightCf")],
    leftNorm: r[ix("leftNorm")],
    rightNorm: r[ix("rightNorm")],
    nameEdit: Number(r[ix("editDistance")]),
    nameRel: Number(r[ix("relDistance")]),
    truth: r[ix("label")] as "same" | "diff",
    den: `${r[ix("leftDen")]} ⟷ ${r[ix("rightDen")]}`,
  }));

  const nSame = pairs.filter((p) => p.truth === "same").length;
  console.log(`Gold set: ${pairs.length} coppie — ${nSame} same, ${pairs.length - nSame} diff\n`);
  console.log("strategia".padEnd(46), "P".padStart(5), "R".padStart(6), "F1".padStart(6), "  TP/FP/FN");
  console.log("-".repeat(86));
  const results = STRATEGIES.map((s) => ({ s, m: metrics(pairs, s) }));
  for (const { s, m } of results) {
    console.log(
      s.name.padEnd(46),
      m.prec.toFixed(2).padStart(5),
      m.rec.toFixed(2).padStart(6),
      m.f1.toFixed(2).padStart(6),
      `  ${m.tp}/${m.fp}/${m.fn}`,
    );
  }

  // dettaglio errori per le strategie CF-aware
  console.log("\n== errori residui ==");
  for (const { s, m } of results.filter((r) => /S3|S4|S6|S7/.test(r.s.name))) {
    const byId = (id: string) => pairs.find((p) => p.id === id)!.den;
    console.log(`\n${s.name}`);
    if (m.fpIds.length) for (const id of m.fpIds) console.log(`  FP #${id}: ${byId(id)}`);
    if (m.fnIds.length) for (const id of m.fnIds) console.log(`  FN #${id}: ${byId(id)}`);
    if (!m.fpIds.length && !m.fnIds.length) console.log("  (nessun errore)");
  }

  // sweep: una volta attivo il gate CF, quanto conta la soglia di edit di L3?
  console.log("\n== sweep soglia L3 (maxEdit) con gate CF attivo ==");
  for (const maxEdit of [1, 2, 3, 4]) {
    const strat: Strategy = {
      name: `gate CF, L3 maxEdit=${maxEdit}`,
      predict: (p) => {
        const minLen = Math.min(p.leftNorm.length, p.rightNorm.length);
        const cand = p.leftNorm === p.rightNorm || (p.nameEdit >= 1 && p.nameEdit <= maxEdit && p.nameRel <= 0.2 && minLen >= 8);
        return cand && cfRelation(p.leftCf, p.rightCf) !== "diff" ? "same" : "diff";
      },
    };
    const m = metrics(pairs, strat);
    console.log(`  maxEdit=${maxEdit}:  P ${m.prec.toFixed(2)}  R ${m.rec.toFixed(2)}  F1 ${m.f1.toFixed(2)}  (TP ${m.tp}/FP ${m.fp}/FN ${m.fn})`);
  }
}

main().catch((e) => {
  console.error("✗ linkage-eval failed:", e);
  process.exitCode = 1;
});
