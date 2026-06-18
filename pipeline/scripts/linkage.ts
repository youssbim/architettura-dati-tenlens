// Record linkage CF-aware — sostituisce linkage-l2 + linkage-l3 (name-only).
// Gira su DUE label: :Impresa e :StazioneAppaltante (il prof ha chiesto il
// linkage delle denominazioni di entrambe).
//
// Per ogni coppia candidata applica linkVerdict (src/lib/cf.ts), che combina
// l'evidenza del codice fiscale con quella del nome in quattro livelli:
//   merge/bridge → stesso ente   → arco (:STESSO_SOGGETTO)
//   review       → incerto       → arco (:POSSIBILE_DUPLICATO)  (da rivedere)
//   reject       → enti distinti → nessun arco
//
// "Generosi sui nomi, severi sul codice fiscale": i candidati nascono dal nome
// (uguale o fuzzy), ma a decidere è il CF — così gli omonimi con P.IVA diverse
// NON vengono fusi.
//
// Pulisce gli archi vecchi e ricostruisce da zero.
// Uso: npm run linkage:cf

import { read, write, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";
import { linkVerdict, editDistance, type LinkTier } from "../lib/cf";

const LABELS = ["Impresa", "StazioneAppaltante"] as const;
type Label = (typeof LABELS)[number];

const MIN_LEN = 8; // soglia per il fuzzy (sotto è rumore)
const GROUP_CAP = 50; // gruppi omonimi enormi: limita l'enumerazione
const BLOCK_CAP = 600;
const BATCH = 2000;

type Node = { cf: string; den: string; norm: string };
type Pair = { lowCf: string; highCf: string; tier: LinkTier; via: string; score: number };
type Tally = Record<LinkTier, number>;

async function writeRels(label: Label, rows: Pair[], rel: string): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await write(
      `UNWIND $rows AS row
       MATCH (a:${label} {cf: row.lowCf}), (b:${label} {cf: row.highCf})
       MERGE (a)-[r:${rel}]->(b)
         ON CREATE SET r.method = 'linkVerdict',
                       r.tier = row.tier,
                       r.via = row.via,
                       r.score = row.score,
                       r.linkedAt = datetime()`,
      { rows: chunk },
    );
  }
}

// Genera i candidati per una label e li classifica con linkVerdict.
async function linkLabel(label: Label): Promise<{ same: Pair[]; review: Pair[]; counts: Tally; n: number }> {
  const nodes = await read<Node>(
    `MATCH (i:${label})
     WHERE i.denominazioneNormalizzata IS NOT NULL AND i.cf IS NOT NULL
       AND size(i.denominazioneNormalizzata) >= 4
     RETURN i.cf AS cf, i.denominazione AS den, i.denominazioneNormalizzata AS norm`,
  );

  const same: Pair[] = [];
  const review: Pair[] = [];
  const counts: Tally = { merge: 0, bridge: 0, review: 0, reject: 0 };

  function handle(a: Node, b: Node, via: string, score: number): void {
    if (a.cf === b.cf) return;
    const v = linkVerdict(a.cf, b.cf, a.norm, b.norm);
    counts[v.tier]++;
    const [lo, hi] = a.cf < b.cf ? [a, b] : [b, a];
    const p: Pair = { lowCf: lo.cf, highCf: hi.cf, tier: v.tier, via, score };
    if (v.tier === "merge" || v.tier === "bridge") same.push(p);
    else if (v.tier === "review") review.push(p);
  }

  // EXACT: stesso nome normalizzato
  const byNorm = new Map<string, Node[]>();
  for (const i of nodes) {
    if (!byNorm.has(i.norm)) byNorm.set(i.norm, []);
    byNorm.get(i.norm)!.push(i);
  }
  for (const [, group] of byNorm) {
    const seen = new Set<string>();
    const arr: Node[] = [];
    for (const x of group) if (!seen.has(x.cf)) { seen.add(x.cf); arr.push(x); }
    if (arr.length < 2) continue;
    const list = arr.length > GROUP_CAP ? arr.slice(0, GROUP_CAP) : arr;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) handle(list[i], list[j], "exact", 1);
  }

  // NEAR: fuzzy edit 1-2 con blocking sui primi 3 caratteri
  const blocks = new Map<string, Node[]>();
  for (const i of nodes) {
    if (i.norm.length < MIN_LEN) continue;
    const k = i.norm.slice(0, 3);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(i);
  }
  for (const [, group] of blocks) {
    const g = group.length > BLOCK_CAP ? group.slice(0, BLOCK_CAP) : group;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        if (a.cf === b.cf || a.norm === b.norm) continue;
        if (Math.abs(a.norm.length - b.norm.length) > 2) continue;
        const d = editDistance(a.norm, b.norm);
        if (d < 1 || d > 2) continue;
        if (d / Math.min(a.norm.length, b.norm.length) > 0.2) continue;
        handle(a, b, "near", Number((1 - d / Math.max(a.norm.length, b.norm.length)).toFixed(3)));
      }
    }
  }

  return { same, review, counts, n: nodes.length };
}

async function main(): Promise<void> {
  const t0 = Date.now();

  // 1) pulizia (vecchi name-only + eventuali nuovi da run precedenti)
  console.log("→ pulizia archi di linkage...");
  for (const rel of [
    "STESSO_SOGGETTO_L2",
    "POSSIBILE_DUPLICATO_DI",
    "STESSO_SOGGETTO",
    "POSSIBILE_DUPLICATO",
  ]) {
    const [{ n }] = await write<{ n: number }>(
      `MATCH ()-[r:${rel}]->() WITH r LIMIT 1000000 DELETE r RETURN count(r) AS n`,
    );
    if (n) console.log(`  cancellati ${n} :${rel}`);
  }

  const perLabel: Record<string, { same: number; review: number; counts: Tally }> = {};
  let totSame = 0, totReview = 0;

  // 2) linkage per ciascuna label
  for (const label of LABELS) {
    const { same, review, counts, n } = await linkLabel(label);
    console.log(
      `→ ${label}: ${n.toLocaleString("it-IT")} nodi · ` +
        `merge ${counts.merge} · bridge ${counts.bridge} · review ${counts.review} · reject ${counts.reject}`,
    );
    await writeRels(label, same, "STESSO_SOGGETTO");
    await writeRels(label, review, "POSSIBILE_DUPLICATO");
    perLabel[label] = { same: same.length, review: review.length, counts };
    totSame += same.length;
    totReview += review.length;
  }

  // 3) log su Mongo
  const d = await db();
  await d.collection("linkage_runs").insertOne({
    kind: "linkage-cf",
    at: new Date(),
    labels: LABELS,
    perLabel,
    stessoSoggetto: totSame,
    possibileDuplicato: totReview,
    durationMs: Date.now() - t0,
  });

  const totReject = Object.values(perLabel).reduce((s, x) => s + x.counts.reject, 0);
  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      `${totSame} stesso-soggetto, ${totReview} da rivedere, ${totReject} omonimi rifiutati ` +
      `(imprese + stazioni appaltanti)`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ linkage failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
