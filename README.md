# TenLens

Analisi dei dati di appalto pubblico ANAC (Pubblicità Legale + OCDS) su
**MongoDB + Neo4j + Elasticsearch**: pipeline ETL, record linkage, ricerca semantica,
benchmark di scalabilità e un chatbot in linguaggio naturale.

Il progetto è diviso in quattro parti indipendenti:

| Cartella | Cos'è | Per iniziare |
|---|---|---|
| **[`pipeline/`](pipeline/)** | Il **motore dati** (TenLens): ETL, librerie, script CLI, benchmark, docker-compose. È la parte da eseguire per costruire il database. | [`pipeline/README.md`](pipeline/README.md) |
| **[`app/`](app/)** | Il **chatbot** (Next.js + AI SDK): interroga il grafo in linguaggio naturale (NL→Cypher). Progetto a sé, con il proprio `package.json`. | [`app/README.md`](app/README.md) |
| **[`benchmarks/`](benchmarks/)** | **Risultati e grafici** dei benchmark di scalabilità (`.jsonl` + `.png`), prodotti dagli script in `pipeline/scripts/`. | [`benchmarks/README.md`](benchmarks/README.md) |
| **[`docs/`](docs/)** | **Presentazione e report**: slide (`presentazione.{md,html,pdf}`) e relazione (`report/report.pdf`). | — |

## Da dove partire

1. **Costruire i dati** → segui [`pipeline/README.md`](pipeline/README.md) (Docker, ETL, ecc.). Tutti i comandi `npm run …` si lanciano da `pipeline/`.
2. **Provare il chatbot** → dopo aver popolato gli store, vai in [`app/`](app/) e segui il suo README.
3. **Guardare i risultati** → grafici e numeri in [`benchmarks/`](benchmarks/); slide e relazione in [`docs/`](docs/).

## Stack

MongoDB (store documentale + raw) · Neo4j (grafo entità/appalti, record linkage) ·
Elasticsearch (ricerca full-text e semantica) · Next.js + AI SDK (chatbot).
