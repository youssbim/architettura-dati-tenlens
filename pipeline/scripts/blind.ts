// Test ALLA CIECA per il record linkage.
// Spezza la circolarità: le etichette si decidono guardando SOLO i nomi,
// senza il codice fiscale né la predizione del sistema. Poi si confronta la
// strategia (che invece usa il CF) contro queste etichette indipendenti.
//
//   npm run blind:prepare   → crea il foglio cieco (solo i due nomi)
//   <annoti a mano blindLabel = same|diff|? nel foglio>
//   npm run blind:score     → svela i CF e confronta
//
// File: blind-seed99-full.csv (completo, NON guardare) · blind.csv (cieco).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { linkVerdict } from "../lib/cf";

const FULL = path.join(process.cwd(), "scripts", "data", "blind-seed99-full.csv");
const BLIND = path.join(process.cwd(), "scripts", "data", "blind.csv");

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}
const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function prepare(): Promise<void> {
  const rows = parseCsv(await readFile(FULL, "utf8"));
  const h = rows[0];
  const iId = h.indexOf("id"), iL = h.indexOf("leftDen"), iR = h.indexOf("rightDen");
  // ordine mescolato (seed fisso) per non dare indizi sulla banda
  const body = rows.slice(1);
  let a = 1234567;
  for (let i = body.length - 1; i > 0; i--) {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    const j = a % (i + 1);
    [body[i], body[j]] = [body[j], body[i]];
  }
  const out = [["n", "leftDen", "rightDen", "blindLabel"].join(",")];
  body.forEach((r, k) => out.push([String(k + 1), q(r[iL]), q(r[iR]), ""].join(",")));
  await writeFile(BLIND, out.join("\n") + "\n", "utf8");
  console.log(`✓ foglio cieco → ${path.relative(process.cwd(), BLIND)}  (${body.length} coppie)\n`);
  console.log("Etichetta ogni riga con same | diff | ? guardando SOLO i nomi:\n");
  body.forEach((r, k) => console.log(`  ${String(k + 1).padStart(2)}.  ${r[iL]}   ⟷   ${r[iR]}`));
}

async function score(): Promise<void> {
  const full = parseCsv(await readFile(FULL, "utf8"));
  const hf = full[0];
  const fL = hf.indexOf("leftDen"), fR = hf.indexOf("rightDen");
  const fLcf = hf.indexOf("leftCf"), fRcf = hf.indexOf("rightCf");
  const fLn = hf.indexOf("leftNorm"), fRn = hf.indexOf("rightNorm");
  // mappa per coppia di nomi → riga completa
  const byNames = new Map<string, string[]>();
  for (const r of full.slice(1)) byNames.set(`${r[fL]}|||${r[fR]}`, r);

  const blind = parseCsv(await readFile(BLIND, "utf8"));
  const hb = blind[0];
  const bL = hb.indexOf("leftDen"), bR = hb.indexOf("rightDen"), bLab = hb.indexOf("blindLabel");

  let agree = 0, total = 0, unsure = 0;
  const nameFooled: string[] = []; // nome cieco "same" ma CF dice "diff" (omonimi)
  const cfRecovered: string[] = []; // nome cieco "diff/?" ma CF dice "same" (refuso/bridge)
  const otherDisagree: string[] = [];

  for (const r of blind.slice(1)) {
    const human = (r[bLab] || "").trim().toLowerCase();
    const f = byNames.get(`${r[bL]}|||${r[bR]}`);
    if (!f) continue;
    const v = linkVerdict(f[fLcf], f[fRcf], f[fLn], f[fRn]);
    const algo = v.same ? "same" : "diff";
    const line = `${r[bL]}  ⟷  ${r[bR]}\n        umano(nome)=${human || "—"}  algoritmo(CF)=${algo}  [${v.tier}]  CF: ${f[fLcf]} / ${f[fRcf]}\n        ${v.reason}`;
    if (human === "?" || human === "") { unsure++; }
    total++;
    if (human === algo) { agree++; continue; }
    if (human === "same" && algo === "diff") nameFooled.push(line);
    else if ((human === "diff" || human === "?") && algo === "same") cfRecovered.push(line);
    else otherDisagree.push(line);
  }

  console.log(`Confronto su ${total} coppie — accordo umano(nome) vs algoritmo(CF): ${agree}/${total} (${((100 * agree) / total).toFixed(0)}%)`);
  console.log(`(${unsure} etichettate "?" perché dal nome non si capisce)\n`);
  console.log(`== Il nome ti ha ingannato: tu "stessa", il CF dice DIVERSE (omonimi) — ${nameFooled.length} ==`);
  nameFooled.forEach((l) => console.log("  • " + l));
  console.log(`\n== Il CF recupera ciò che il nome non vedeva: tu "diverse/?", il CF dice STESSA — ${cfRecovered.length} ==`);
  cfRecovered.forEach((l) => console.log("  • " + l));
  if (otherDisagree.length) {
    console.log(`\n== altri disaccordi — ${otherDisagree.length} ==`);
    otherDisagree.forEach((l) => console.log("  • " + l));
  }
}

const mode = process.argv[2];
(mode === "score" ? score() : prepare()).catch((e) => {
  console.error("✗ blind failed:", e);
  process.exitCode = 1;
});
