# ETL — TendersLens

Pipeline che trasforma i dati grezzi ANAC in dati interrogabili.
**Principio guida: una casa canonica, due fonti, una chiave (il CIG).**

Ogni stadio è un file numerato, leggibile dall'alto in basso, con in testa il suo
contratto (*cosa entra · cosa esce · chiave · perché è idempotente · controfattuale*).
Tutti gli stadi sono **idempotenti** (re-run sul solo delta) e **stateless** (lo stato
è in Mongo, si riparte da lì).

```
①ingest    ANAC API ──▶ raw_pl, raw_ocds
②canonical raw_*    ──▶ lotti                [chiave: CIG]
③linkage   lotti    ──▶ soggetti, entita     [blocking + 4 livelli]
④embed     lotti    ──▶ lotti.embedding      [OpenAI 1536-dim]
─────────────────────────────────────────────────────────────────
⑤sync      lotti/entita ──▶ Neo4j + ES       (viste derivate — separato)
```

## I file

| File | Stadio | Entra → Esce | Chiave |
|---|---|---|---|
| `1-ingest.ts`    | INGEST    | API ANAC → `raw_pl` | `idAvviso` |
| `2-canonical.ts` | NORMALIZE+MERGE | `raw_*` → `lotti` | **CIG** |
| `3-linkage.ts`   | RECORD LINKAGE | `lotti` → `soggetti`,`entita` | CF |
| `4-embed.ts`     | EMBEDDING | `lotti` → `lotti.embedding` | — |
| `pipeline.ts`    | ORCHESTRATORE | esegue ①→④ in ordine | — |
| `_run.ts`        | helper | `isMain` (standalone vs importato) | — |

## Come si esegue

```bash
npm run etl                  # pipeline completa ①→④
SKIP_INGEST=true npm run etl # riprocessa il già scaricato (niente rete ANAC)

# stadi singoli (eseguibili da soli)
npm run etl:ingest           # ① solo download (keyset, finestre di data)
npm run etl:canonical        # ②
npm run etl:linkage          # ③
npm run etl:embed            # ④
```

Flag di skip: `SKIP_INGEST` · `SKIP_CANONICAL` · `SKIP_LINKAGE` · `SKIP_EMBED`.

## Il contratto di output

Dopo `npm run etl`, in **MongoDB**:

- **`lotti`** — un record canonico per CIG: oggetto, importo, stazione appaltante,
  aggiudicatari (entità risolte), `embedding` 1536-dim, provenienza (`_sources`).
- **`soggetti`** — un doc per CF, con il suo `entityId`.
- **`entita`** — le entità reali risolte (golden record).
- **`linkage_review`** — le coppie incerte, da confermare a mano.

> MongoDB è la **verità**. Neo4j (grafo) ed Elasticsearch (vettori) sono viste
> **derivate**, costruite dallo stadio ⑤ e ricostruibili da Mongo.

## Perché è fatto così (decisioni + numeri misurati)

| Stadio | Scelta | Controfattuale (se NON lo facessi) |
|---|---|---|
| ① ingest | upsert su `idAvviso` · keyset per data | senza upsert: lake gonfiato **×30**; con offset: pagine profonde a **120s** (vs 36s); concorrenza 20 → **504** su tutte |
| ② canonical | merge per **CIG** · adapter per scheda | senza adapter: aggiudicatari persi sull'**84%**; senza CIG: gare doppie (idAppalto≠ocid) |
| ③ linkage | blocking + decisione sul CF | senza blocking: **24,7M** coppie invece di **226** (−99,999%) |
| ④ embed | vettori semantici 1536-dim | senza: ricerca solo lessicale (*"mensa" ≠ "refezione"*) |

I dettagli completi e i benchmark: `docs/etl.md`, `docs/linkage.md`, `docs/benchmark-etl.md`.
