# TenLens — pipeline dati (motore)

Pipeline ANAC (Pubblicità Legale + OCDS) su **MongoDB + Neo4j + Elasticsearch**, con
record linkage, embedding semantici e benchmark di scalabilità.

Questa è la cartella `pipeline/` del bundle TenLens: il **motore dati**, autonomo e
riproducibile in locale. I benchmark vivono in `../benchmarks/`, il chatbot in `../app/`,
presentazione e report in `../docs/`. **Tutti i comandi qui sotto si lanciano da questa
cartella (`pipeline/`).**

```
pipeline/
├── etl/          pipeline ETL a stadi (1-ingest → 2-canonical → 3-linkage → 4-embed)
├── lib/          moduli condivisi (mongo, neo4j, es, adapter PL/OCDS, cf, model, ...)
├── scripts/      script CLI: ingest, build, linkage, gold set, benchmark, plotting
├── data/         grezzi congelati (raw_pl / raw_ocds, archivi Mongo)
├── docker-compose.yml          Mongo + Neo4j + Elasticsearch
├── docker-compose.shard.yml    cluster shardato (curva di sharding)
└── docker-compose.bench.yml    profilo dedicato ai benchmark
```

## Prerequisiti

- **Docker** (e Docker Compose) per gli store dati
- **Node.js 20+**
- Una **OPENAI_API_KEY** (serve per gli embedding `etl:embed` e per il chatbot)

## Riproduzione end-to-end

### 1. Configura le variabili d'ambiente

```bash
cp .env.example .env.local
# apri .env.local e inserisci la tua OPENAI_API_KEY
```

Le altre chiavi puntano già agli store locali avviati da Docker (Mongo su 27017,
Neo4j su 7687, Elasticsearch su 9200).

### 2. Avvia gli store dati

```bash
docker compose up -d
```

Avvia `garagraph-mongo`, `garagraph-neo4j`, `garagraph-es`. Attendi qualche secondo
che Neo4j ed Elasticsearch siano pronti.

### 3. Installa le dipendenze

```bash
npm install
```

### 4. ETL

Pipeline completa (esegue in sequenza i 4 stadi):

```bash
npm run etl
```

Oppure stadio per stadio:

```bash
npm run etl:ingest      # 1. scarica gli avvisi ANAC (PL/OCDS) → MongoDB (raw)
npm run etl:canonical   # 2. normalizza in lotti canonici + contributi (adapter PL/OCDS)
npm run etl:linkage     # 3. record linkage: bridge CIG e merge per soggetto (CF/P.IVA)
npm run etl:embed       # 4. genera gli embedding dei lotti (OpenAI) per la ricerca semantica
```

Comandi accessori utili:

```bash
npm run db:bootstrap    # crea indici/vincoli su Neo4j e Mongo
npm run graph:sync      # proietta i dati canonici nel grafo Neo4j
npm run ingest:status   # stato dell'ingest
npm run etl:idempotency # verifica l'idempotenza della ri-esecuzione
```

### 5. Benchmark

Benchmark applicativi (lettura/scrittura, ricerca, query):

```bash
npm run bench:ingest-db      # throughput di scrittura su DB
npm run bench:query          # query analitiche
npm run bench:search         # ricerca semantica: Mongo brute-force vs Elasticsearch
npm run bench:es             # ricerca su Elasticsearch
npm run bench:index          # costruzione indice
npm run bench:linkage-scale  # scalabilità del record linkage
npm run bench:shard          # curva di sharding (usa docker-compose.shard.yml)
npm run bench:failover       # comportamento in failover
```

Script di supporto allo sharding e al plotting (in `scripts/`):

```bash
bash scripts/shard-setup.sh        # configura il cluster shardato
bash scripts/bench-shard-curve.sh  # esegue la curva al variare del numero di shard
python3 scripts/plot-query.py      # grafico latenza query
python3 scripts/plot-search.py     # grafico ricerca semantica
python3 scripts/plot-shard.py      # grafico curva di sharding
```

Gli script di benchmark scrivono i risultati (`.jsonl`) e i grafici (`.png`) in
**`../benchmarks/`** — vedi [`../benchmarks/README.md`](../benchmarks/README.md).

### 6. Record linkage / gold set

```bash
npm run goldset:build      # costruisce il gold set (campionamento annotabile)
npm run goldset:annotate   # interfaccia di annotazione manuale (CF-based)
npm run linkage:eval       # valuta precision/recall del linkage sul gold set
npm run linkage:status     # riepilogo delle relazioni di linkage nel grafo
npm run goldset:ceiling    # ceiling teorico raggiungibile
```

### 7. App chatbot

Il chatbot (Next.js + AI SDK, NL→Cypher con resolve-then-query) è un sotto-progetto
in `../app/`. Richiede gli stessi store attivi (passi 2 e 4) e le chiavi nel proprio
`app/.env.local`.

```bash
cd ../app
npm install
# crea app/.env.local con le stesse chiavi del bundle (OPENAI_API_KEY,
# MONGODB_URI, NEO4J_*, ES_URL, ES_INDEX, OPENAI_MODEL, EMBED_MODEL)
npm run dev
```

Poi apri http://localhost:3000.
