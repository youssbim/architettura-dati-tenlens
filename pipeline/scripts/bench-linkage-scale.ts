// BENCHMARK scaling della fase di ANALISI (record linkage) al 25/50/75/100% dei dati.
// Mostra che con il blocking il linkage scala ~lineare invece di O(n²).
// Uso: npm run bench:linkage-scale

import { db, closeClient } from "../lib/mongo";
import { normalizeDenominazione } from "../lib/transform";
import { linkVerdict, editDistance } from "../lib/cf";

const MIN_LEN = 8, MAX_EDIT = 2, MAX_REL = 0.2;
type S = { cf: string; dn: string; bk: string };

function runLinkage(soggetti: S[]) {
  const blocks = new Map<string, S[]>();
  for (const s of soggetti) { if (!blocks.has(s.bk)) blocks.set(s.bk, []); blocks.get(s.bk)!.push(s); }
  const parent = new Map<string, string>();
  const find = (x: string): string => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  let comparisons = 0, merges = 0;
  for (const [, g] of blocks) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      let cand = a.dn === b.dn && a.dn.length > 0;
      if (!cand && a.dn.length >= MIN_LEN && b.dn.length >= MIN_LEN && Math.abs(a.dn.length - b.dn.length) <= MAX_EDIT) {
        const dist = editDistance(a.dn, b.dn);
        cand = dist >= 1 && dist <= MAX_EDIT && dist / Math.min(a.dn.length, b.dn.length) <= MAX_REL;
      }
      if (!cand) continue;
      comparisons++;
      const v = linkVerdict(a.cf, b.cf, a.dn, b.dn);
      if (v.tier === "merge" || v.tier === "bridge") { union(a.cf, b.cf); merges++; }
    }
  }
  return { blocks: blocks.size, comparisons, merges };
}

async function main(): Promise<void> {
  const d = await db();
  console.log("→ carico i lotti…");
  const lotti = await d.collection("lotti").find({}, { projection: { stazioneAppaltante: 1, aggiudicazioni: 1 } }).toArray() as any[];
  const N = lotti.length;
  console.log(`  ${N} lotti\n`);

  console.log("| % dati | lotti | soggetti | blocchi | confronti (blocking) | confronti O(n²) | riduzione | merge | tempo |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    const k = Math.floor(N * frac);
    // estrai soggetti distinti per CF dal sottoinsieme
    const map = new Map<string, S>();
    const add = (cf: string, den: string) => { if (!cf) return; if (!map.has(cf)) { const dn = normalizeDenominazione(den || ""); map.set(cf, { cf, dn, bk: dn.slice(0, 3) }); } };
    for (let i = 0; i < k; i++) {
      const l = lotti[i];
      if (l.stazioneAppaltante?.cf) add(l.stazioneAppaltante.cf, l.stazioneAppaltante.denominazione);
      for (const a of l.aggiudicazioni ?? []) add(a.impresa.cf, a.impresa.denominazione);
    }
    const soggetti = [...map.values()];
    const t0 = performance.now();
    const r = runLinkage(soggetti);
    const ms = performance.now() - t0;
    const onq = soggetti.length * (soggetti.length - 1) / 2;
    const riduz = (onq / Math.max(r.comparisons, 1)).toFixed(0);
    console.log(`| ${(frac * 100).toFixed(0)}% | ${k.toLocaleString()} | ${soggetti.length.toLocaleString()} | ${r.blocks.toLocaleString()} | ${r.comparisons.toLocaleString()} | ${onq.toLocaleString()} | ${riduz}× | ${r.merges} | ${ms.toFixed(0)} ms |`);
  }
  console.log("\n(con blocking il linkage scala ~lineare; senza, O(n²) esploderebbe)");
  await closeClient();
}

main().catch((e) => { console.error("✗ failed:", e); process.exitCode = 1; }).finally(closeClient);
