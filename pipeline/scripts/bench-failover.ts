// ESPERIMENTO tolleranza ai guasti: crollo di un nodo (lettura/scrittura).
// Scrive in loop su un replica set a 3 nodi; a metà esperimento ferma il PRIMARY
// (docker stop) e misura: downtime delle SCRITTURE (durata elezione) e continuità
// delle LETTURE dai secondary. Richiede: docker compose -f docker-compose.bench.yml up -d
// Uso: npm run bench:failover

import { MongoClient, ReadPreference } from "mongodb";
import { execSync } from "node:child_process";

const HOSTS = ["host.docker.internal:27031", "host.docker.internal:27032", "host.docker.internal:27033"];
const URI = `mongodb://${HOSTS.join(",")}/?replicaSet=rs0`;
const CMAP: Record<string, string> = { "27031": "garagraph-bench-rs1-1", "27032": "garagraph-bench-rs2-1", "27033": "garagraph-bench-rs3-1" };
const DURATION_MS = 30000, KILL_AT_MS = 6000, STEP_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const coll = client.db("bench").collection("fo");
  await coll.deleteMany({});

  const hello = await client.db("admin").command({ hello: 1 });
  const primary: string = hello.primary;
  const container = CMAP[primary.split(":")[1]];
  console.log(`primary attuale: ${primary} → container ${container}\n`);

  let n = 0, okW = 0, failW = 0, killed = false, stopElapsed = 0;
  const wlat: { e: number; l: number; ok: boolean }[] = [];
  const rlat: { e: number; l: number; ok: boolean }[] = [];
  const t0 = Date.now();

  while (Date.now() - t0 < DURATION_MS) {
    const e = Date.now() - t0;
    if (!killed && e >= KILL_AT_MS) { killed = true; stopElapsed = e; console.log(`[t=${(e/1000).toFixed(1)}s] 🔴 docker stop ${container} (PRIMARY)`); try { execSync(`docker stop ${container}`, { stdio: "ignore" }); } catch {} }
    // SCRITTURA (sul primary, con failover automatico del driver)
    let tw = Date.now();
    try { await coll.insertOne({ n: n++, ts: new Date() }); okW++; wlat.push({ e, l: Date.now() - tw, ok: true }); }
    catch { failW++; wlat.push({ e, l: Date.now() - tw, ok: false }); }
    // LETTURA da secondary (deve restare disponibile)
    let tr = Date.now();
    try { await coll.estimatedDocumentCount({ readPreference: ReadPreference.SECONDARY_PREFERRED } as never); rlat.push({ e, l: Date.now() - tr, ok: true }); }
    catch { rlat.push({ e, l: Date.now() - tr, ok: false }); }
    await sleep(STEP_MS);
  }

  // analisi: finestra di indisponibilità in SCRITTURA = scritture fallite o lat>1s dopo lo stop
  const impacted = wlat.filter((w) => w.e >= stopElapsed && (!w.ok || w.l > 1000));
  const downStart = impacted.length ? impacted[0].e : null;
  const downEnd = impacted.length ? impacted[impacted.length - 1].e + impacted[impacted.length - 1].l : null;
  const maxW = Math.max(...wlat.map((w) => w.l));
  const readsFailedAfter = rlat.filter((r) => r.e >= stopElapsed && !r.ok).length;
  const readMaxAfter = Math.max(...rlat.filter((r) => r.e >= stopElapsed).map((r) => r.l));

  let newPrimary = "?";
  try { newPrimary = (await client.db("admin").command({ hello: 1 })).primary; } catch {}

  console.log(`\n=== RISULTATI failover ===`);
  console.log(`  scritture: ${okW} ok, ${failW} fallite (su ${n})`);
  console.log(`  SCRITTURE — downtime: ${downStart != null ? `~${((downEnd! - downStart) / 1000).toFixed(1)}s (da t=${(downStart/1000).toFixed(1)}s)` : "nessuno"}; latenza max ${(maxW/1000).toFixed(1)}s`);
  console.log(`  LETTURE (da secondary) dopo lo stop: ${readsFailedAfter} fallite, latenza max ${readMaxAfter}ms → ${readsFailedAfter === 0 ? "CONTINUE ✅" : "interrotte"}`);
  console.log(`  nuovo primary: ${newPrimary} (era ${primary})`);
  console.log(`  documenti scritti totali: ${await coll.estimatedDocumentCount()}`);

  await client.close();
  console.log(`\n↩  riavvio il nodo fermato…`);
  try { execSync(`docker start ${container}`, { stdio: "ignore" }); } catch {}
}

main().catch((e) => { console.error("✗ bench-failover failed:", e.message); process.exitCode = 1; });
