# Benchmark — materiale per il report

Misure su dati reali (dataset completo 2,3M+ avvisi). Grafici PNG allegati.

> Nota terminologica: i **25/50/75/100%** del prof sono **frazioni del dataset** (asse ①),
> NON percentili. **p50/p95** sono i **percentili di latenza** (mediana / coda) con cui riportiamo
> ogni misura — scelta nostra di metodo.

---

## 0. Latenza al variare del dataset (asse ① del prof: "25-50-75-100% dei dati")

*"Stessi nodi, dataset crescente: come scala?"* — 1 nodo, sottoinsiemi 25/50/75/100% dei
2.391.921 lotti, query rappresentative (p50/p95 ms). Grafici `query-scale-*.png`.

| % dati | lotti | 🎯 Lookup CIG (indice _id) | 🔍 Filtro stazione (indice) | 📊 Aggregazione (full-scan) |
|---|---|---:|---:|---:|
| 25% | 597.980 | 1,7 / 3,5 | 4,8 / 55,6 | 1167 / 3022 |
| 50% | 1.195.960 | 2,0 / 9,1 | 14,9 / 117,1 | 2250 / 3426 |
| 75% | 1.793.940 | 0,6 / 2,0 | 10,0 / 134,0 | 4378 / 6456 |
| 100% | 2.391.921 | 1,1 / 3,2 | 26,3 / 187,2 | **5133 / 10241** |

- **Lookup per CIG (indice `_id`): ~costante** ~1-2 ms a qualunque dimensione → **O(log n)**.
- **Filtro su indice**: cresce piano (più dati = più documenti che matchano e tornano).
- **Aggregazione full-scan: cresce ~lineare** — 1167 → 5133 ms (**4,4×** da 25→100%).

**Ingestion (scrittura DB) alle stesse frazioni** — il prof chiedeva *"ingestion E analisi"*:

| Dataset | doc/s |
|---|---:|
| 25% (598k) | 35.479 |
| 50% (1,2M) | 38.041 |
| 75% (1,8M) | 34.328 |
| 100% (2,4M) | 35.488 |

→ throughput di scrittura **~35k doc/s costante** al crescere della collezione: la dimensione
**non degrada** gli insert (manutenzione indici stabile). *Scala piatta.* Grafici `ingest-scale`.

> **Il ponte ①→②**: l'aggregazione full-scan cresce lineare col dataset e su **1 nodo sbatte
> contro il muro** → è esattamente ciò che lo **sharding** (asse ②, sotto) cura parallelizzando
> lo scatter-gather sugli shard. Gli indici fanno scalare le query mirate a qualsiasi volume.

---

## 0-ter. Indice SÌ vs NO — il valore dell'indice

Il prof: *"costruisciti un indice… che poi ti servirà"*. Misura della **stessa ricerca di società**
CON l'indice (O(log n)) e SENZA (collection scan O(n)), a scala piena. Grafico `index-onoff.png`.

| Ricerca | CON indice p50/p95 | SENZA (scan) p50/p95 | speedup |
|---|---:|---:|---:|
| Gare di un'azienda (lotti, 2,4M) | 14,9 / 390 ms | **3132 / 4304 ms** | **211×** |
| Azienda per nome (soggetti, 426k) | 0,78 / 1,03 ms | 73 / 95 ms | **94×** |

→ Senza indice Mongo scorre **tutta** la collezione (3,1 s su 2,4M lotti); con indice è **sub-ms / ~ms**.
L'indice dà **94-211×**. Conferma empirica del *"gli indici fanno scalare"* dell'asse ① (e del
**blocking** del linkage: stesso principio applicato al confronto fra società).

> Distinzione: l'**indice DB** qui misurato (B-tree su `_id`/campi) ≠ l'**indice dei soggetti**
> del linkage (blocking per non confrontare tutti-con-tutti) — due usi del concetto, entrambi richiesti.

---

## 0-bis. Tolleranza al guasto (asse ③ del prof: "se un nodo casca, lettura E scrittura")

Replica-set a 3 nodi (`docker-compose.bench.yml`). Scritture continue + letture da secondary;
a t=6s **kill del PRIMARY** (`docker stop`) sotto carico.

| | Risultato |
|---|---|
| **Scritture** | 181 ok / 182 → **1 fallita**, downtime **~0 s**, latenza max **0,2 s**, poi riprendono **da sole** |
| **Letture** (da secondary) | **0 fallite**, latenza max **3 ms** → **mai interrotte** ✅ |
| **Recovery** | nuovo primary **eletto automaticamente** (rs1→rs2); nodo riavviato |

→ Il sistema **si auto-ripara**: pausa sub-secondo in scrittura, **nessuna perdita**, letture continue.
È la **high availability** del replica-set.

> **Vincolo architetturale**: MongoDB fa **sharding** (scala orizzontale, asse ②) **+** replica-set
> **HA** (questo, asse ③). **Neo4j Community fa solo HA** (repliche leader/follower), **non shardizza**
> → la distribuzione "vera" vive su Mongo (shard sul CIG); Neo4j si replica solo per disponibilità.

---

## 1. Sharding MongoDB — scaling sui nodi (asse ② del prof: "2-3-4-5-…nodi")

*"Stessi dati, più nodi: come scala?"* — shard key **hash del CIG** (pre-split → distribuzione
all'inserimento, niente migrazione/orfani). Curva **1→5 shard**.

### 500.000 lotti — curva pulita (grafici `*-500k.png`, host alleggerito: solo Mongo principale)

| Shard | Distribuzione | ✍️ Scrittura | 📖 Aggregazione p50/p95 | 🎯 Puntuale p50/p95 |
|---|---|---:|---:|---:|
| 1 | 500k | 37,6k doc/s | 672 / 773 ms | 1,09 / 1,65 ms |
| 2 | 251k+249k | 43,7k doc/s | 491 / 627 ms | 0,96 / 2,04 ms |
| 3 | 166k×3 | 47,6k doc/s | 427 / 603 ms | 0,79 / 1,37 ms |
| 4 | 125k×4 | **51,6k doc/s** | 330 / 377 ms | 0,84 / 1,28 ms |
| 5 | 100k×5 | 45,4k doc/s | **328** / ⚠️14581 ms | 1,27 / 1,79 ms |

- **Aggregazione (scatter-gather) ↓ monotòna**: 672 → 328 ms p50 (**−51%, ~2×**) — parallelismo sugli shard.
- **Scrittura ↑ fino a 4 nodi** (37→**51,6k**, +37%), **poi cala a 5**: oltre 4 shard-processo l'host (8 GB, 1 CPU) **satura** → si *vede* il tetto della macchina singola.
- **Puntuale per CIG ~costante** (~1 ms) — colpisce 1 solo shard.
- **Distribuzione uniforme** (hash del CIG): nessun hotspot.
- ⚠️ **Spike p95 a N=5** (14,5 s): stallo isolato sotto carico di picco su 8 GB — il p50 resta pulito,
  ma è la prova misurata che a 5 nodi serve **hardware separato**, non più cache.

### 1.000.000 lotti — stress test (grafici `*-1M.png`)

| Shard | ✍️ Scrittura | 📖 Aggregazione p50/p95 | 🎯 Puntuale p50 |
|---|---:|---:|---:|
| 1 | 31,6k | 1733 / 2375 ms | 1,15 ms |
| 2 | 40,4k | 1081 / 1424 ms | 1,08 ms |
| 3 | 41,2k | 1096 / 1506 ms | 1,20 ms |
| 4 | 34,2k | 763 / 1737 ms | 1,61 ms |
| 5 | 40,7k | **681 / 806 ms** | 1,23 ms |

- A 1M il guadagno è più marcato in assoluto (1733 → 681 ms) ma la curva è **più rumorosa e non monotòna**.

### Cloud — droplet dedicato NVMe (la curva pulita, grafici `*-nvme.png`)

DigitalOcean **c-4** (4 vCPU dedicati + **NVMe**), Amsterdam — 500k, 1→5 shard.
Hardware dedicato + disco veloce → **scale-out da manuale, monotòno su entrambi gli assi**:

| Shard | ✍️ Scrittura | 📖 Aggregazione p50/p95 | 🎯 Puntuale p50/p95 |
|---|---:|---:|---:|
| 1 | 20,0k doc/s | 1786 / 1885 ms | 1,32 / 3,19 ms |
| 2 | 23,4k doc/s | 1201 / 1508 ms | 1,87 / 3,20 ms |
| 3 | 24,7k doc/s | 1169 / 1297 ms | 1,86 / 2,52 ms |
| 4 | 25,0k doc/s | 1067 / 1181 ms | 1,89 / 2,62 ms |
| 5 | **25,9k doc/s** | **1051 / 1126 ms** | 2,01 / 2,97 ms |

- **Scrittura ↑ monotòna**: 20,0 → 25,9k (**+30%**), sale a *ogni* nodo.
- **Aggregazione ↓ monotòna**: 1786 → 1051 ms (**−41%**), scende a *ogni* nodo. p95 stretti, niente spike.
- **Puntuale ~costante** (~2 ms): shard key ben scelta.

### Lezione misurata: lo storage layer domina

Confronto dello stesso bench (500k, 1→5) su tre ambienti:

| Ambiente | Scrittura N=1 | Aggregazione N=1→5 | Puntuale |
|---|---:|---:|---:|
| Laptop NVMe (8 GB, **contended**) | 37k | 672 → 328 ms (rumorosa) | ~1 ms |
| Droplet **Basic** (disco lento, IOPS limitati) | **7,6k** | 4227 → 2079 ms | **11-21 ms** |
| Droplet **c-4 NVMe** (dedicato) | 20k | **1786 → 1051 ms (pulita)** | ~2 ms |

→ Il **disco** è il fattore dominante: il droplet *Basic* (IOPS limitati) crolla in scrittura e
puntuale; solo con **NVMe + CPU dedicata** la curva diventa pulita e monotòna su tutti gli assi.
Un benchmark di sharding è **sensibilissimo allo storage layer** — da dichiarare nel report.

### Lettura per il report — il limite è il risultato

> ⚠️ I 5 shard girano sulla **stessa macchina** (7 container mongo che condividono CPU/RAM/disco).
> Oltre 2-3 shard-processo si **satura l'hardware del laptop** → il plateau della scrittura e il
> rumore a 1M **dimostrano empiricamente** la differenza tra *shard-come-processi-su-1-macchina*
> e *shard-su-hardware-separato*. Per una curva pulita e lineare servirebbe **1 shard per nodo
> fisico** (es. Oracle Always Free multi-VM). È la motivazione misurata del passo successivo.

> Metodologia: cache WiredTiger cappata per nodo (cfg 0,25 GB · shard 0,5 GB); `embedding` escluso
> dalla proiezione (irrilevante alle query strutturali). Cluster `docker-compose.shard.yml` ·
> setup `scripts/shard-setup.sh` · curva `scripts/bench-shard-curve.sh` (1→5).

Riproduci: `LOAD=500000 bash scripts/bench-shard-curve.sh && python3 scripts/plot-shard.py`

---

## 2. Scrittura ETL — ingest OCDS + merge cross-fonte

Dimostrazione del **write-path** dell'ETL su dati nuovi (OCDS mese 2, non ancora presenti):

| Fase | Lavoro | Tempo | Throughput |
|---|---|---:|---:|
| ① ingest OCDS (bulk stream) | 30.000 release → `raw_ocds` | 51,5 s | ~583 doc/s |
| ② canonical (merge per CIG) | 27.500 grezzi → 39.434 upsert | 4 s | ~9,8k upsert/s |

**Merge cross-fonte (la tesi centrale):** dopo il merge,
- **22.024 lotti** hanno **entrambe le fonti** (`pl` + `ocds`) → stesso CIG comparso in PL *e* OCDS,
  fuso in **un solo record** (il CIG è la chiave di join tra fonti con ID diversi);
- 21.579 lotti solo-OCDS (CIG assenti in PL).

→ `lotti`: 2.372.353 → **2.391.921**.

---

## 3. Record linkage — riduzione O(n²) (asse ③)

Su 426.564 soggetti (CF distinti) estratti dai 2,37M lotti:

| | Valore |
|---|---:|
| coppie senza blocking, O(n²) | **90.978.209.766** (~91 mld) |
| confronti reali col blocking | **94.100** |
| riduzione | **−99,9999%** |

11.726 imprese comparse con più CF/nomi, unite in un'unica entità. Dettagli ed esempi reali
in `tenLens/etl/RESULTS.md`.

---

## 4. Ricerca vettoriale — MongoDB brute-force vs Elasticsearch (HNSW)

Ricerca semantica kNN sui vettori dei lotti (top-10). Vettori **reali**, **512 dim**
(troncamento Matryoshka dai 1536 → entra in 8 GB e mostra anche il trade-off dimensioni).
Scale 125/250/375/500k. Grafici `search-latency.png`, `search-recall.png`.

| N | Mongo p50 | ES p50 | ES più veloce | Mongo q/s | ES q/s | ES recall@10 | ES index time |
|---|---:|---:|---:|---:|---:|---:|---:|
| 125k | 42,5 ms | 15,5 ms | 2,7× | 22 | 30 | 97,0% | 72 s |
| 250k | 83,5 ms | 26,1 ms | 3,2× | 12 | 25 | 96,7% | 139 s |
| 375k | 137,9 ms | 30,4 ms | 4,5× | 7 | 22 | 92,7% | 225 s |
| 500k | **183,4 ms** | **41,6 ms** | **4,4×** | **5** | **18** | 89,3% | 274 s |

**Throughput** (la richiesta del prof *"quante richieste al minuto"*) — grafico `search-throughput.png`:
- **Mongo crolla**: 22 → **5 q/s** (−77%) al crescere di N (ogni query scansiona tutto, O(N)).
- **ES regge**: 30 → **18 q/s** (−40%, molto più piatto) — l'indice HNSW non scansiona tutto.
- La forbice si allarga: 1,4× a 125k → **3,6×** a 500k. In richieste/minuto a 500k: Mongo ~**300/min**, ES ~**1.080/min**.
  → per molti utenti concorrenti a scala, **Mongo brute-force non regge il carico interattivo, ES sì**.

- **MongoDB brute-force**: cosine in-app, **O(N) lineare** (42→183 ms, ×4,3 su ×4 dati),
  **recall 100% (esatto)**, **zero infra/build**. A 500k già 183 ms / 5 q/s → lento per l'interattivo.
  Estrapolazione: 1M ≈ 370 ms, 2,4M ≈ ~880 ms → **inutilizzabile a scala piena**.
- **Elasticsearch HNSW**: **sublineare** (15→42 ms), **4-5× più veloce** e la forbice **si allarga**
  con N. Ma: **recall scende 97→89%** (approssimato, `num_candidates=100` fisso) e **build costoso**
  (72→274 s) + un sistema in più da gestire/dimensionare.

**Il trade-off da dichiarare**: *velocità + scala (ES)* vs *esattezza + zero-infra (Mongo)*.
Punto di scelta: ≤~100k Mongo basta (esatto, semplice); da ~250-500k in su, se la ricerca è
interattiva, ES vince in latenza — al prezzo di recall < 100% e di un indice da mantenere.

> Nota dimensioni: a **512 dim** (vs 1536) i vettori pesano ⅓, il kNN è più veliciale e su testi
> corti (oggetti di gara, ~114 char medi) il recall resta alto → ottimo compromesso recall/costo.

---

## 5. Modulo LLM → query sul grafo (NL → Cypher)

Il livello di intelligence traduce le domande in linguaggio naturale in interrogazioni
Cypher sul grafo Neo4j (304k Lotto, 118k Impresa, 20k Ente). Implementato come agente
**function-calling** (`gpt-5-mini`) con due tool, nell'app `tenLens/app`:

- **`risolviEntità(nome, tipo?)`** — risolve un nome impreciso/troncato/con refusi nei
  candidati reali via **full-text index fuzzy** (`entitaNomi`), ritorna i top-10 con chiave
  esatta (`cf`), `nGare` e `score`. L'LLM sceglie il candidato pertinente.
- **`queryGrafo(cypher, params)`** — esegue Cypher in **sola lettura** sulla chiave esatta
  risolta (niente `CONTAINS` su nome libero).

Flusso a due passi orchestrato dall'LLM: **risolvi l'entità → interroga il grafo**.

### Gold set — 10 domande NL (file `llm-cypher-goldset.md`)

Domande rappresentative (lookup, conteggi, classifiche, concentrazione di mercato, profilo
impresa, relazioni, CPV), ciascuna con il Cypher atteso validato a mano sul grafo.

| Metrica | Valore |
|---|---:|
| domande corrette | **10 / 10** |
| domande risolte via `risolviEntità` (basate sui nomi) | 3 (Q6, Q7, Q8) |

**Refuso/troncamento (prova esplicita):** *"chi vince le gare del comune di milan"* →
`risolviEntità` corregge in **COMUNE DI MILANO** (cf `01199250158`) → `queryGrafo` per cf
esatto. Un `CONTAINS 'milan'` ingenuo avrebbe invece restituito 139 enti rumorosi
(incluso il falso positivo "Don Lorenzo **Milani**").

### Valore misurato della risoluzione vs `CONTAINS`

Per Q7/Q8 la risoluzione sul **cf canonico** dà numeri più bassi ma **corretti**: per gli
enti in comune Maggioli ∩ Halley, **46 (esatto)** contro 61 del vecchio `CONTAINS 'MAGGIOLI'`,
che conflava le varianti ("MAGGIOLI S.P.A. / SPA / EDITORE"). È il valore aggiunto del tool.

> Dettagli ed esito per singola domanda in `llm-cypher-RESULTS.md`. Tutte le query restano
> in sola lettura (sessione Neo4j `READ`). Riproducibile con l'app su `tenLens/app`.
