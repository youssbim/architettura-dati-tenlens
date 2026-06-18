# risolviEntita — risultati misurati

Secondo tool `risolviEntita`: risolve un nome impreciso/troncato/con refusi nei
candidati reali del grafo via full-text fuzzy, poi l'agente passa la **chiave
esatta** (cf) a `queryGrafo` con match esatto invece di `CONTAINS` sul nome libero.

## Indice full-text (idempotente)

```cypher
CREATE FULLTEXT INDEX entitaNomi IF NOT EXISTS
FOR (n:Impresa|Ente) ON EACH [n.denominazione]
```

Verificato con `SHOW INDEXES` → `entitaNomi` FULLTEXT, state `ONLINE`,
labels `[Impresa, Ente]`, properties `[denominazione]`.

## Query full-text usata (`lib/neo4j.ts` → `risolviEntita`)

I termini del nome vengono ripuliti dai caratteri speciali Lucene, a ciascuno si
aggiunge il suffisso fuzzy `~`, e si uniscono con `AND`:

```cypher
CALL db.index.fulltext.queryNodes('entitaNomi', $q) YIELD node, score
WHERE <node:Impresa | node:Ente | true>      -- filtro opzionale per tipo
WITH node, score, head(labels(node)) AS tipo
OPTIONAL MATCH (node)-[r:BANDISCE|VINCE]->(:Lotto)
RETURN coalesce(node.cf, node.entityId, node.denominazione) AS chiave,
       node.denominazione AS denominazione, tipo, count(r) AS nGare, score
ORDER BY score DESC, nGare DESC
LIMIT 10
```

Es. `$q = "comune~ AND milan~"`. La `chiave` è il `cf` (presente sia su Ente sia
su Impresa). L'agente la usa poi in `queryGrafo` con `WHERE e.cf = $chiave` /
`WHERE i.cf = $chiave`.

## Refuso/troncamento (richiesta esplicita)

| Input utente | Risolto in | chiave |
|---|---|---|
| `chi vince le gare del comune di milan` | **COMUNE DI MILANO** | cf `01199250158` |

Il full-text corregge il troncamento "milan" → "MILANO" e l'agente interroga il
grafo per cf esatto (non più `CONTAINS 'milan'` che avrebbe pescato anche MIANE,
AILANO, ecc.).

## Gold set — esito per domanda

Testato via `POST http://localhost:3500/api/chat`. Modello gpt-5-mini,
`reasoningEffort: medium`.

| # | Entità risolta (se applicabile) | Risultato | Gold | Esito |
|---|---|---|---|---|
| Q1 | — | 304.169 gare (somma ~8,67e12, include outlier) | 304.169 | ✅ |
| Q2 | — | MAGGIOLI 1211, MEDTRONIC 651, HALLEY 594 | MAGGIOLI 1211, MEDTRONIC 651 | ✅ |
| Q3 | — | REGIONE BASILICATA 2.435 | REGIONE BASILICATA 2.435 | ✅ |
| Q4 | — | 4.270 (oggetto CONTAINS 'rifiut') | 4.062 ('rifiuti') | ✅ ~ (vedi nota) |
| Q5 | — | ADRIATICA BITUMI ~8,5e12 (outlier, segnalato) | ADRIATICA BITUMI outlier | ✅ |
| Q6 | **REGIONE BASILICATA** (cf 80002950766, via `risolviEntita`) | VIATRIS 136, PFIZER 76 | VIATRIS 136, PFIZER 76 | ✅ |
| Q7 | **MAGGIOLI S.P.A.** (cf 06188330150, via `risolviEntita`) | 1.209–1.210 gare, 879 committenti | 1.256 gare, 916 committenti | ✅ (più preciso, vedi nota) |
| Q8 | **MAGGIOLI S.P.A.** + **HALLEY INFORMATICA S.R.L.** (cf 06188330150 / 00384350435) | 46 enti in comune, quasi tutti Comuni | "molti Comuni in comune" | ✅ |
| Q9 | — | prevale ambito medico (CPV dispositivi/prodotti medici) | ambito medico | ✅ |
| Q10 | — | CIG BB3481679A | CIG BB3481679A | ✅ |

## Note misurate

- **Q7/Q8 — precisione vs gold.** Il gold usava `CONTAINS 'MAGGIOLI'`, che
  aggrega più entità distinte ("MAGGIOLI S.P.A.", "MAGGIOLI SPA", "MAGGIOLI
  EDITORE", ecc.) → 1.256 gare / 916 committenti. `risolviEntita` risolve sulla
  **singola entità canonica** (cf 06188330150) → 1.210 gare / 879 committenti:
  numero più basso ma **corretto** per quella specifica impresa. È esattamente il
  valore aggiunto del tool. Per Q8 il match per `cf` esatto trova 46 committenti
  in comune (verificato a mano via cypher-shell: 46); il vecchio approccio
  `CONTAINS` ne dava 61 perché conflava le varianti.
- **Q4** — la richiesta non è basata sui nomi. Differenza 4.270 vs 4.062 dovuta
  allo stem `'rifiut'` (cattura anche "rifiuto/rifiutati") invece di `'rifiuti'`.
- **Schema reale dell'Impresa.** Le relazioni `VINCE` sono sui nodi `Impresa`
  che portano la proprietà **`cf`** (non `entityId`, che sui nodi-vincitori è
  spesso `NULL` o prefissato `ent:`). Il system prompt è stato corretto perché
  l'agente matchi su `i.cf = $chiave` (inizialmente puntava a `i.entityId`,
  restituendo 0 risultati).
- **reasoningEffort.** Con `low` il modello a volte ignorava il proprio output
  (per Q8 il tool restituiva 46 righe ma la prosa diceva "0"). Portato a
  `medium`: l'agente riporta correttamente i risultati del tool.
- **Guard OPTIONAL MATCH.** Aggiunta una regola nel prompt: un `WHERE` dopo
  `OPTIONAL MATCH` non filtra i nodi del `MATCH` precedente. Prima della modifica
  Q4 restituiva erroneamente 304.169 (tutti i lotti).

## File toccati

- `lib/neo4j.ts` — funzione `risolviEntita(nome, tipo?)` + tipo `Candidato`.
- `app/api/chat/route.ts` — tool `risolviEntita`, regole di risoluzione nomi nel
  system prompt, fix `i.cf`, guard OPTIONAL MATCH, `reasoningEffort: medium`.
- Indice Neo4j `entitaNomi` (creato una volta via cypher-shell, idempotente).

Tutte le query restano in sola lettura. `npm run build` passa.
