// Test: classificazione tematica via embedding (ES script_score cosine).
// Embedda una descrizione del tema "sanitario", conta quante gare superano una
// soglia di similarità, e mostra i top risultati + confronto col keyword match.
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const KEY = env.OPENAI_API_KEY;
const ES = env.ES_URL || "http://localhost:9200";
const INDEX = env.ES_INDEX || "bandi";

const TEMA = "forniture e servizi sanitari: dispositivi medici, farmaci e medicinali, materiale ospedaliero, presidi, attrezzature per ASL e ospedali";

const er = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: "text-embedding-3-small", input: TEMA }),
});
const vec = (await er.json()).data[0].embedding;

async function esCount(body) {
  const r = await fetch(`${ES}/${INDEX}/_search`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}

// totale documenti
const all = await esCount({ size: 0, track_total_hits: true, query: { match_all: {} } });
const N = all.hits.total.value;

// quante gare superano varie soglie di cosine similarity
console.log(`Totale gare nell'indice: ${N}\n`);
console.log("Soglia cosine  →  gare sopra soglia (= 'sanitarie' a quella soglia)");
for (const soglia of [0.55, 0.6, 0.65, 0.7]) {
  const res = await esCount({
    size: 0, track_total_hits: true,
    query: {
      script_score: {
        query: { match_all: {} },
        script: { source: "cosineSimilarity(params.q, 'vec') + 1.0", params: { q: vec } },
        min_score: soglia + 1.0,
      },
    },
  });
  console.log(`  ${soglia.toFixed(2)}        →  ${res.hits.total.value}`);
}

// top 8 per verificare la precisione
const top = await esCount({
  size: 8,
  query: { script_score: { query: { match_all: {} }, script: { source: "cosineSimilarity(params.q,'vec')+1.0", params: { q: vec } } } },
  _source: ["oggetto"],
});
console.log("\nTop 8 (più vicini al tema) — verifica precisione:");
top.hits.hits.forEach((h, i) => console.log(`  ${i + 1}. [${(h._score - 1).toFixed(3)}] ${(h._source.oggetto || "").slice(0, 70)}`));

// confronto: keyword "medic*" nell'oggetto
const kw = await esCount({ size: 0, track_total_hits: true, query: { wildcard: { oggetto: "*medic*" } } });
console.log(`\nConfronto keyword: gare con 'medic' nell'oggetto = ${kw.hits.total.value}`);
