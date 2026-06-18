# Risultati ETL — dataset completo (giugno 2026)

Esecuzione della pipeline pulita (`etl/`) sull'**intero dataset** Pubblicità Legale
(2,3M avvisi scaricati col keyset). Tutti i numeri sono **misurati**, non stimati.

## Volumi prodotti

| Collezione | Documenti | Cos'è |
|---|---:|---|
| `raw_pl` | 2.327.815 | avvisi grezzi (copia fedele API) |
| **`lotti`** | **2.372.353** | record canonici, uno per CIG (verità) |
| `soggetti` | 426.564 | CF distinti (imprese + stazioni appaltanti) |
| **`entita`** | **413.038** | entità reali dopo record linkage |
| `entita` multi-CF | 11.726 | imprese comparse con più CF/nomi, unite |
| `linkage_review` | 16.470 | coppie incerte → revisione umana |

> Il dataset di lavoro è passato da **603k → 2,37M lotti** ricostruendo dai 2,3M grezzi.

## Performance (codice pulito, laptop)

| Stadio | Lavoro | Tempo |
|---|---|---:|
| ② canonical | 2.252.615 grezzi → 2.488.060 upsert | **246 s** |
| ③ linkage | 426.564 soggetti, blocking + union-find | **57 s** |

Lo stadio ② gira **batched + bulk** (1 `find($in)` + 1 `bulkWrite` per blocco di 20k):
memoria limitata (2,3M non ci stanno in RAM) e nessun round-trip per-CIG → 4 minuti, non ore.

## Idempotenza — provata a scala piena

Re-run dello stadio ② con tutti i grezzi già `_synced`:

```
✓ ② canonical — 0 grezzi → 0 upsert, lotti totale 2372353 (0s)
```

Stesso input → stesso output, **0 duplicati**. La garanzia viene da: chiave naturale
(`_id = idAvviso` per i grezzi, `_id = CIG` per i lotti) + upsert + guardie anti-duplicato
su tutte le liste del merge (`avvisi`, `aggiudicazioni`, `cpv`, `rettifiche`).

## Record linkage — il problema, con dati reali

**Blocking (la richiesta del prof — "non confrontare tutti con tutti"):**

| | Valore |
|---|---:|
| soggetti (CF distinti) | 426.564 |
| coppie senza blocking, O(n²) | **90.978.209.766** (~91 miliardi) |
| confronti reali col blocking | **94.100** |
| riduzione | **−99,9999%** |

**Esiti della decisione a 4 livelli:** 16.835 merge · 16.470 review · resto reject.
**11.726 imprese** comparivano con più CF/nomi e sono state unite in un'unica entità.

### Esempi reali (entità multi-CF risolte)

```
• Spada Marco                         → P.IVA 03183790751  ↔  CF persona SPDMRC77L17D883J   [BRIDGE: ditta individuale]
• ARREDI 3N dei Fratelli Nespoli srl  → 01019660156 / 1019660156 / 010196601156            [MERGE: refusi/zeri della P.IVA]
• BATTIONI LOGISTICA S.r.l.           → P.IVA 02782820340 ↔ CF GNNNMR57L63H501X + refuso    [BRIDGE + MERGE]
• Powermedia S.r.l.                   → 04440930826 / 04400930826                            [MERGE: una cifra di differenza]
• AIRONSTAND S.R.L.                   → 11954791009 / 11994791009                            [MERGE: una cifra]
```

Questi mostrano i due casi che il nome da solo non risolverebbe:
- **merge** — stessa P.IVA con un refuso/zero mancante (il checksum la riconosce);
- **bridge** — la ditta individuale appare sia con la **P.IVA** sia col **CF della persona**.

## Riproducibilità

```bash
SKIP_INGEST=true npm run etl   # ② canonical + ③ linkage + ④ embed sui grezzi già scaricati
npm run etl:canonical          # solo ②
npm run etl:linkage            # solo ③
```

I grezzi sono congelati in `data/raw_pl/` (24 shard NDJSON.gz, 713 MB) →
la pipeline si ri-esegue senza ri-scaricare da ANAC.
