// Carica i `lotti` (con embedding) dentro l'indice ES `bandi` per la ricerca kNN
// usata dalla chat. Idempotente sul singolo doc (_id = cig). Ricrea l'indice da zero.
//
// Uso: ES_URL=http://localhost:9200 npm run index:es
import { db, closeClient } from "../lib/mongo";
import { ensureIndex, esRequest, INDEX_NAME } from "../lib/es";

const BULK = Number(process.env.BULK ?? 500);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  const d = await db();
  const L = d.collection("lotti");
  const one = await L.findOne({ embedding: { $exists: true } }, { projection: { embedding: 1 } }) as any;
  if (!one) throw new Error("nessun lotto con embedding");
  const dim = one.embedding.length;
  const total = await L.countDocuments({ embedding: { $exists: true } });
  console.log(`→ indicizzo ${total} bandi (dim=${dim}) in ES/${INDEX_NAME}…`);

  await ensureIndex(dim, true); // ricrea da zero

  const cursor = L.find(
    { embedding: { $exists: true } },
    { projection: { embedding: 1, oggetto: 1, natura: 1, importoBase: 1, dataScadenza: 1, "stazioneAppaltante.denominazione": 1, "aggiudicazioni.0": 1 } },
  ) as any;

  let body = "", n = 0, t0 = performance.now();
  const flush = async () => { if (body) { await esRequest("POST", `/${INDEX_NAME}/_bulk`, body, true); body = ""; } };
  for await (const l of cursor) {
    const scad = typeof l.dataScadenza === "string" && /^\d{4}-\d{2}-\d{2}$/.test(l.dataScadenza) ? l.dataScadenza : null;
    const doc = {
      vec: l.embedding,
      oggetto: l.oggetto ?? null,
      natura: l.natura ?? null,
      importoBase: l.importoBase ?? null,
      dataScadenza: scad,
      stazioneAppaltante: l.stazioneAppaltante?.denominazione ?? null,
      aggiudicato: Array.isArray(l.aggiudicazioni) && l.aggiudicazioni.length > 0,
    };
    body += `{"index":{"_id":${JSON.stringify(l._id)}}}\n${JSON.stringify(doc)}\n`;
    n++;
    if (n % BULK === 0) { await flush(); if (n % 20000 === 0) console.log(`  …${n}/${total} (${((performance.now() - t0) / 1000).toFixed(0)}s)`); }
  }
  await flush();
  await esRequest("POST", `/${INDEX_NAME}/_refresh`);
  const count = await esRequest("GET", `/${INDEX_NAME}/_count`);
  console.log(`✓ indicizzati ${count.count} doc in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  await closeClient();
}

main().catch((e) => { console.error("✗ index-es failed:", e); process.exitCode = 1; }).finally(closeClient);
