# Gold set — 10 domande NL → Cypher (validato sul grafo reale)

Benchmark per il modulo LLM→Cypher. Ogni Cypher è stato eseguito su Neo4j
(304k Lotto, 118k Impresa, 20k Ente) e produce risultati reali.

| # | Domanda (NL) | Cypher atteso | Esito reale |
|---|---|---|---|
| Q1 | Quante gare ci sono in totale e per che valore? | `MATCH (l:Lotto) RETURN count(l), sum(l.importo)` | 304.169 gare |
| Q2 | Le 5 imprese che hanno vinto più gare | `MATCH (i:Impresa)-[:VINCE]->(:Lotto) RETURN i.denominazione, count(*) ORDER BY .. DESC LIMIT 5` | MAGGIOLI 1211, MEDTRONIC 651 |
| Q3 | I 5 enti che hanno bandito più gare | `MATCH (e:Ente)-[:BANDISCE]->(l:Lotto) RETURN e.denominazione, count(l) ORDER BY .. DESC LIMIT 5` | REGIONE BASILICATA 2435 |
| Q4 | Quante gare riguardano i rifiuti? | `MATCH (l:Lotto) WHERE toLower(l.oggetto) CONTAINS 'rifiuti' RETURN count(*)` | 4.062 |
| Q5 | Le imprese che hanno vinto più valore complessivo | `MATCH (i:Impresa)-[:VINCE]->(l:Lotto) WHERE l.importo IS NOT NULL RETURN i.denominazione, sum(l.importo) ORDER BY .. DESC LIMIT 5` | ADRIATICA BITUMI (outlier) |
| Q6 | Chi vince le gare della Regione Basilicata? | `MATCH (e:Ente)-[:BANDISCE]->(l)<-[:VINCE]-(i:Impresa) WHERE e.denominazione CONTAINS 'REGIONE BASILICATA' RETURN i.denominazione, count(*) ORDER BY .. DESC LIMIT 5` | VIATRIS 136, PFIZER 76 |
| Q7 | Profilo di Maggioli: gare, importo, n. committenti | `MATCH (i:Impresa)-[:VINCE]->(l) WHERE i.denominazione CONTAINS 'MAGGIOLI' OPTIONAL MATCH (l)<-[:BANDISCE]-(e:Ente) RETURN count(DISTINCT l), sum(l.importo), count(DISTINCT e)` | 1256 gare, 916 committenti |
| Q8 | Quali enti hanno in comune Maggioli e Halley? | `MATCH (a)-[:VINCE]->(:Lotto)<-[:BANDISCE]-(e:Ente)-[:BANDISCE]->(:Lotto)<-[:VINCE]-(b) WHERE a.denominazione CONTAINS 'MAGGIOLI' AND b.denominazione CONTAINS 'HALLEY' RETURN DISTINCT e.denominazione LIMIT 10` | molti Comuni in comune |
| Q9 | Le categorie merceologiche (CPV) più frequenti | `MATCH (l:Lotto)-[:HA_CPV]->(c:Cpv) RETURN c.codice, count(*) ORDER BY .. DESC LIMIT 5` | prevale ambito medico |
| Q10 | Mostrami il dettaglio di una gara | `MATCH (l:Lotto) RETURN l.cig, l.oggetto, l.importo, l.procedura LIMIT 1` | CIG BB3481679A |

## Note emerse (utili per il design dei tool)
- I **nomi** vanno cercati con `CONTAINS`+`toLower` (match esatto fallisce) → motiva il tool `risolviEntità`.
- `Lotto.importo` può essere **null** e contiene **outlier** (es. ADRIATICA BITUMI 8.5e12) → da gestire in aggregazione.
- `Cpv.codice` è **misto**: a volte codice (`33190000-8`), a volte descrizione → da normalizzare.
- Q6/Q8 (concentrazione, enti in comune) sono il vero valore del grafo.
