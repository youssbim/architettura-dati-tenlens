# Scelte di esclusione (nota, fuori dal report)

Componenti lasciate fuori scope, come scelte motivate e dove possibile supportate da una
misura. Tenuta come nota separata, non inclusa nella relazione.

## Gruppi societari e amministratore delegato
Ricostruire la mappa delle partecipazioni e degli organi amministrativi (e tracciarne
l'evoluzione nel tempo) richiederebbe fonti non disponibili gratuitamente, come Cerved o il
Registro Imprese. In assenza di tali dati, inferire i legami di gruppo dai soli avvisi ANAC
sarebbe speculativo: si preferisce dichiararne l'assenza.

## Subappalti
Esclusi non per scelta arbitraria ma dopo verifica empirica:
- L'OCDS, unica fonte delle gare nel grafo, non pubblica il subappalto: su tutte le 790.279
  release, **0** hanno il campo `contracts.subcontracting`.
- Il dataset CSV separato dei subappalti ANAC descrive autorizzazioni in fase di esecuzione e
  punta in larga parte a gare 2020–2023 non presenti nel grafo: il join via CIG riesce solo
  per l'**1,3%** dei casi (4.247 su 330.140), trascinando ~99% di nodi orfani nei benchmark.

Il sistema modella quindi la sola catena verificabile end-to-end: stazione appaltante →
avviso → appalto → aggiudicatario. L'estensione ai subappalti resta una leva opzionale,
subordinata a un backfill OCDS pluriennale e al recupero del dataset dedicato.

## Matching semantico ATECO ↔ CPV
Stretch goal per collegare il settore merceologico di un'impresa agli oggetti di gara. Limite
a monte nei dati: il codice ATECO non compare negli avvisi ANAC e i nodi impresa ne sono
privi; procurarselo richiederebbe una fonte a pagamento. Esperimento non avviato.
