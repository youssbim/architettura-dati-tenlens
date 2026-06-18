// Utility sul codice fiscale / partita IVA italiani, usate da record linkage
// e dall'annotazione del gold set. Singola fonte di verità.
//
// Idea portante: il CF/P.IVA è l'identità legale. Quando è valido e diverso
// decide da solo (enti distinti); quando è malformato o di tipo diverso
// (CF persona vs P.IVA) l'evidenza è inconcludente e va combinata col nome.

export type CfKind = "PIVA" | "CF" | "NUM_BAD" | "FOREIGN" | "OTHER";
export type CfClass = { kind: CfKind; valid: boolean };

// ---- Partita IVA: 11 cifre, checksum di Luhn ----
export function isValidPIVA(s: string): boolean {
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

// ---- Codice fiscale persona: 16 caratteri, carattere di controllo ----
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
// pattern tollerante all'omocodia (lettere al posto di cifre negli slot numerici)
export const CF_RE = /^[A-Z]{6}[0-9A-Z]{2}[A-Z][0-9A-Z]{2}[A-Z][0-9A-Z]{3}[A-Z]$/;

export function isValidCF(s: string): boolean {
  if (!CF_RE.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    sum += (i + 1) % 2 === 1 ? ODD[s[i]] : EVEN[s[i]];
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15];
}

export function classifyCf(raw: string): CfClass {
  const s = (raw ?? "").trim().toUpperCase();
  if (/^\d{11}$/.test(s)) return { kind: "PIVA", valid: isValidPIVA(s) };
  if (CF_RE.test(s)) return { kind: "CF", valid: isValidCF(s) };
  if (/^\d{8,13}$/.test(s)) return { kind: "NUM_BAD", valid: false }; // P.IVA con cifre errate
  if (/^[A-Z]{2}[0-9A-Z]{3,}$/.test(s)) return { kind: "FOREIGN", valid: false }; // ESB…, BG…
  return { kind: "OTHER", valid: false };
}

// distanza di edit (Levenshtein) tra due stringhe brevi
export function editDistance(a: string, b: string): number {
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

// Verdetto basato SOLO sull'identificativo, indipendente dal nome:
//   "diff"         → il CF prova che sono enti distinti (non unire mai)
//   "same"         → il CF prova che è lo stesso ente (refuso / identico)
//   "inconclusive" → il CF non basta (CF persona vs P.IVA, o entrambi invalidi):
//                     la decisione va presa col nome
export type CfRelation = "same" | "diff" | "inconclusive";

export function cfRelation(leftCf: string, rightCf: string, typoMaxEdit = 2): CfRelation {
  const a = (leftCf ?? "").trim().toUpperCase();
  const b = (rightCf ?? "").trim().toUpperCase();
  if (a && a === b) return "same";
  const l = classifyCf(a);
  const r = classifyCf(b);
  const cfEdit = editDistance(a, b);

  // due identificativi validi dello stesso tipo, diversi → enti distinti.
  // (un refuso di una cifra romperebbe quasi sempre il checksum, quindi due
  // P.IVA entrambe valide non sono lo stesso ente per errore di battitura)
  if (l.kind === "PIVA" && r.kind === "PIVA") {
    if (l.valid && r.valid) return "diff";
    if (cfEdit <= typoMaxEdit) return "same"; // almeno una non valida + vicina → refuso
    return "inconclusive";
  }
  if (l.kind === "CF" && r.kind === "CF") {
    if (l.valid && r.valid) return "diff";
    return cfEdit <= typoMaxEdit ? "same" : "inconclusive";
  }
  if (l.kind === "FOREIGN" || r.kind === "FOREIGN") return "diff";

  // P.IVA valida vs numerico malformato vicino → refuso della stessa P.IVA
  if (
    (l.kind === "PIVA" && l.valid && r.kind === "NUM_BAD") ||
    (r.kind === "PIVA" && r.valid && l.kind === "NUM_BAD")
  ) {
    return cfEdit <= typoMaxEdit ? "same" : "inconclusive";
  }

  // CF persona vs P.IVA (ditta individuale) o casi misti → serve il nome
  return "inconclusive";
}

// ---- Compromesso di linkage a livelli ----
// Combina l'evidenza del CF con quella del nome in quattro esiti:
//   "merge"  → stesso ente, certo dal CF (CF identico o refuso)
//   "bridge" → stesso ente, alta fiducia (CF persona↔P.IVA + nome coincidente):
//              tipica ditta individuale presente con due identificativi
//   "review" → candidato sul nome ma CF inconcludente e nome non coincidente:
//              NON unire in automatico, segnalare per revisione umana
//   "reject" → il CF prova che sono enti distinti: non unire mai
// merge/bridge contano come "stesso ente"; review/reject come "non unire".
export type LinkTier = "merge" | "bridge" | "review" | "reject";

const despace = (s: string) => (s ?? "").replace(/\s+/g, "");

export function linkVerdict(
  leftCf: string,
  rightCf: string,
  leftNorm: string,
  rightNorm: string,
): { tier: LinkTier; same: boolean; reason: string } {
  const rel = cfRelation(leftCf, rightCf);
  if (rel === "diff")
    return { tier: "reject", same: false, reason: "il CF prova enti distinti (P.IVA/CF validi e diversi, o estero)" };
  if (rel === "same")
    return { tier: "merge", same: true, reason: "stesso CF o refuso di esso" };
  // rel === "inconclusive": il nome può decidere SOLO se è un vero caso
  // persona↔P.IVA (CF persona VALIDO a 16 char + P.IVA VALIDA = ditta
  // individuale). Un CF malformato (NUM_BAD) lontano da una P.IVA NON deve
  // "bridgeare" sul solo nome: altrimenti, per transitività nella union-find,
  // collegherebbe P.IVA valide e distinte ma omonime (es. due "MAGGIOLI SPA").
  const nameMatch = leftNorm === rightNorm || despace(leftNorm) === despace(rightNorm);
  const la = classifyCf(leftCf), rb = classifyCf(rightCf);
  const personaPiva =
    (la.kind === "CF" && la.valid && rb.kind === "PIVA" && rb.valid) ||
    (rb.kind === "CF" && rb.valid && la.kind === "PIVA" && la.valid);
  if (nameMatch && personaPiva)
    return { tier: "bridge", same: true, reason: "CF persona↔P.IVA con denominazione coincidente → stessa ditta individuale" };
  return { tier: "review", same: false, reason: "CF inconcludente (malformato o tipi misti) → revisione, non unione" };
}
