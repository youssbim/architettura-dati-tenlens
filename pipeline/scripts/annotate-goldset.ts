// Annotazione OGGETTIVA del gold set basata sul codice fiscale / P.IVA,
// non sul nome. Per ogni coppia di candidati:
//   - classifica ciascun identificativo: P.IVA (11 cifre), CF persona (16),
//     numerico malformato (10/12 cifre…), estero, altro;
//   - ne verifica il checksum (Luhn P.IVA, check char CF persona);
//   - misura la distanza di edit tra i due identificativi;
//   - applica regole deterministiche → etichetta same/diff + confidenza.
//
// Regola chiave: due P.IVA che superano ENTRAMBE il checksum, anche a 1 cifra
// di distanza, NON sono un refuso (un typo rompe il checksum) → enti diversi.
//
// Output: riscrive scripts/data/goldset.csv con label/confidence/note compilate
// e colonne diagnostiche; stampa il residuo "DA CONFERMARE" e precision/recall
// provvisori confrontando label (verità) vs systemPrediction (cosa fa L2/L3).
//
// Uso: npm run goldset:annotate

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CSV = process.env.GOLD_CSV
  ? path.resolve(process.env.GOLD_CSV)
  : path.join(process.cwd(), "scripts", "data", "goldset.csv");

// ---------- checksum P.IVA (11 cifre) ----------
function isValidPIVA(s: string): boolean {
  if (!/^\d{11}$/.test(s)) return false;
  let x = 0;
  let y = 0;
  for (let i = 0; i < 10; i++) {
    const n = s.charCodeAt(i) - 48;
    if (i % 2 === 0) x += n;
    else {
      const d = n * 2;
      y += d > 9 ? d - 9 : d;
    }
  }
  const c = (10 - ((x + y) % 10)) % 10;
  return c === s.charCodeAt(10) - 48;
}

// ---------- checksum CF persona (16 caratteri) ----------
const ODD: Record<string, number> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
const EVEN: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12,
  N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
};
// pattern tollerante all'omocodia (lettere al posto di cifre in slot numerici)
const CF_RE = /^[A-Z]{6}[0-9A-Z]{2}[A-Z][0-9A-Z]{2}[A-Z][0-9A-Z]{3}[A-Z]$/;
function isValidCF(s: string): boolean {
  if (!CF_RE.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = s[i];
    sum += (i + 1) % 2 === 1 ? ODD[ch] : EVEN[ch];
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15];
}

type Kind = "PIVA" | "CF" | "NUM_BAD" | "FOREIGN" | "OTHER";
type Cls = { kind: Kind; valid: boolean };
function classify(raw: string): Cls {
  const s = raw.trim().toUpperCase();
  if (/^\d{11}$/.test(s)) return { kind: "PIVA", valid: isValidPIVA(s) };
  if (CF_RE.test(s)) return { kind: "CF", valid: isValidCF(s) };
  if (/^\d{8,13}$/.test(s)) return { kind: "NUM_BAD", valid: false }; // P.IVA con cifre errate
  if (/^[A-Z]{2}[0-9A-Z]{3,}$/.test(s)) return { kind: "FOREIGN", valid: false }; // es. ESB…, BG…
  return { kind: "OTHER", valid: false };
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (a === b) return 0;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

type Decision = { label: "same" | "diff"; confidence: "high" | "medium" | "low"; reason: string };

// Quando l'evidenza dal CF è inconcludente (CF persona vs P.IVA, o ID
// malformati lontani) si ricade sul NOME: stesso ente solo se anche la
// denominazione coincide. nameRel = distanza di edit relativa sul norm.
function byName(nameEdit: number, nameRel: number, base: string): Decision {
  if (nameEdit === 0)
    return { label: "same", confidence: "medium", reason: `${base} + nome identico → plausibile stessa ditta individuale (CF persona + P.IVA)` };
  if (nameRel >= 0.25)
    return { label: "diff", confidence: "medium", reason: `${base} + nomi diversi → enti diversi` };
  return { label: nameRel <= 0.12 ? "same" : "diff", confidence: "low", reason: `${base} + nomi simili (rel ${nameRel.toFixed(2)}) → DA CONFERMARE` };
}

function decide(l: Cls, r: Cls, cfEdit: number, nameEdit: number, nameRel: number): Decision {
  const kinds = [l.kind, r.kind].sort().join("+");

  if (l.kind === "PIVA" && r.kind === "PIVA") {
    if (l.valid && r.valid)
      return { label: "diff", confidence: "high", reason: "due P.IVA valide diverse → enti distinti (anche a 1 cifra: un refuso romperebbe il checksum)" };
    if (l.valid !== r.valid)
      return cfEdit <= 2
        ? { label: "same", confidence: "medium", reason: `una P.IVA non supera il checksum, a ${cfEdit} dall'altra valida → refuso` }
        : { label: "diff", confidence: "low", reason: "una P.IVA invalida ma lontana → incerto" };
    return cfEdit <= 2
      ? { label: "same", confidence: "low", reason: "entrambe P.IVA invalide ma vicine → probabile refuso" }
      : { label: "diff", confidence: "low", reason: "entrambe P.IVA invalide e diverse" };
  }

  if (l.kind === "CF" && r.kind === "CF") {
    if (l.valid && r.valid)
      return { label: "diff", confidence: "high", reason: "due CF persona validi diversi → persone diverse (cognome/anno/comune codificati differiscono)" };
    return cfEdit <= 2
      ? { label: "same", confidence: "medium", reason: `CF persona a ${cfEdit} di distanza → refuso` }
      : { label: "diff", confidence: "low", reason: "CF persona diversi" };
  }

  if (l.kind === "FOREIGN" || r.kind === "FOREIGN")
    return { label: "diff", confidence: "high", reason: "identificativo estero → ente diverso" };

  // CF persona vs P.IVA: l'ID non basta → decide il nome
  if (kinds === "CF+PIVA")
    return byName(nameEdit, nameRel, "CF persona vs P.IVA");

  if ((l.kind === "PIVA" || r.kind === "PIVA") && (l.kind === "NUM_BAD" || r.kind === "NUM_BAD")) {
    const validOne = l.kind === "PIVA" ? l.valid : r.valid;
    if (cfEdit <= 2 && validOne)
      return { label: "same", confidence: "medium", reason: `identificativo malformato a ${cfEdit} dalla P.IVA valida → refuso` };
    return byName(nameEdit, nameRel, "P.IVA vs numerico malformato lontano");
  }

  return byName(nameEdit, nameRel, `tipi eterogenei (${l.kind}/${r.kind})`);
}

// ---------- CSV minimal parser (gestisce le virgolette) ----------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c === "\r") { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}
function csvCell(s: string | number): string {
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(CSV, "utf8"));
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);
  const iLeftCf = idx("leftCf");
  const iRightCf = idx("rightCf");
  const iLeftDen = idx("leftDen");
  const iRightDen = idx("rightDen");
  const iPred = idx("systemPrediction");
  const iBand = idx("band");
  const iEdit = idx("editDistance");
  const iRel = idx("relDistance");
  const iLeftNorm = idx("leftNorm");
  const iRightNorm = idx("rightNorm");

  const out: string[][] = [
    ["id", "band", "editDistance", "relDistance", "systemPrediction",
     "leftCf", "leftDen", "rightCf", "rightDen", "leftNorm", "rightNorm",
     "leftCfKind", "rightCfKind", "cfEdit", "label", "confidence", "note"],
  ];

  const needHuman: { id: string; den: string; reason: string }[] = [];
  // confusione per livello: predetto positivo = L2/L3, predetto negativo = none
  const M = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const byLevel: Record<string, { tp: number; fp: number }> = { L2: { tp: 0, fp: 0 }, L3: { tp: 0, fp: 0 } };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const leftCf = row[iLeftCf];
    const rightCf = row[iRightCf];
    const cl = classify(leftCf);
    const cr = classify(rightCf);
    const cfEdit = lev(leftCf.trim().toUpperCase(), rightCf.trim().toUpperCase());
    const nameEdit = Number(row[iEdit]);
    const nameRel = Number(row[iRel]);
    const d = decide(cl, cr, cfEdit, nameEdit, nameRel);
    if (d.confidence === "low") needHuman.push({ id: row[0], den: `${row[iLeftDen]} ⟷ ${row[iRightDen]}`, reason: d.reason });

    out.push([
      row[0], row[iBand], row[iEdit], row[iRel], row[iPred],
      leftCf, row[iLeftDen], rightCf, row[iRightDen], row[iLeftNorm], row[iRightNorm],
      `${cl.kind}${cl.valid ? "✓" : ""}`, `${cr.kind}${cr.valid ? "✓" : ""}`,
      String(cfEdit), d.label, d.confidence, d.reason,
    ]);

    // metriche: la verità è d.label, la predizione del sistema è systemPrediction
    const predPos = row[iPred] === "L2" || row[iPred] === "L3";
    const truePos = d.label === "same";
    if (predPos && truePos) M.tp++;
    else if (predPos && !truePos) M.fp++;
    else if (!predPos && truePos) M.fn++;
    else M.tn++;
    if (predPos && (row[iPred] === "L2" || row[iPred] === "L3")) {
      byLevel[row[iPred]][truePos ? "tp" : "fp"]++;
    }
  }

  await writeFile(CSV, out.map((r) => r.map(csvCell).join(",")).join("\n") + "\n", "utf8");

  const pct = (n: number, d: number) => (d === 0 ? "—" : (n / d).toFixed(2));
  const labels = out.slice(1).map((r) => r[14]);
  const same = labels.filter((l) => l === "same").length;
  const conf = out.slice(1).map((r) => r[15]);

  console.log(`✓ annotato ${out.length - 1} coppie → ${path.relative(process.cwd(), CSV)}\n`);
  console.log(`Etichette: same=${same}  diff=${labels.length - same}`);
  console.log(`Confidenza: high=${conf.filter((c) => c === "high").length}  medium=${conf.filter((c) => c === "medium").length}  low=${conf.filter((c) => c === "low").length}\n`);

  console.log("== Precision / Recall (verità via CF vs systemPrediction L2/L3) ==");
  console.log(`  Precision complessiva: ${pct(M.tp, M.tp + M.fp)}  (TP ${M.tp} / TP+FP ${M.tp + M.fp})`);
  console.log(`  Recall complessivo:    ${pct(M.tp, M.tp + M.fn)}  (TP ${M.tp} / TP+FN ${M.tp + M.fn})`);
  const p = M.tp / (M.tp + M.fp || 1);
  const rec = M.tp / (M.tp + M.fn || 1);
  console.log(`  F1:                    ${(2 * p * rec / (p + rec || 1)).toFixed(2)}`);
  console.log(`  Precision L2: ${pct(byLevel.L2.tp, byLevel.L2.tp + byLevel.L2.fp)}  (${byLevel.L2.tp}/${byLevel.L2.tp + byLevel.L2.fp})`);
  console.log(`  Precision L3: ${pct(byLevel.L3.tp, byLevel.L3.tp + byLevel.L3.fp)}  (${byLevel.L3.tp}/${byLevel.L3.tp + byLevel.L3.fp})\n`);

  console.log(`== ${needHuman.length} coppie DA CONFERMARE a mano (confidenza bassa) ==`);
  for (const h of needHuman) console.log(`  #${h.id.padStart(2)}  ${h.den}\n        ${h.reason}`);
}

main().catch((e) => {
  console.error("✗ annotate-goldset failed:", e);
  process.exitCode = 1;
});
