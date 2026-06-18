---
marp: true
paginate: true
size: 16:9
footer: 'TenLens · Architetture Dati 2025/2026 · Youssef Bimezzagh'
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  :root {
    --navy: #1F2D50;
    --ink: #1a1a1a;
    --muted: #6b7280;
    --line: #e3e6ee;
    --accent: #C2603A;
  }
  section {
    background: #ffffff;
    color: var(--ink);
    font-family: "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 23px;
    line-height: 1.45;
    letter-spacing: -0.01em;
    padding: 58px 78px 74px;
  }
  h1 { color: var(--navy); font-size: 50px; font-weight: 800; line-height: 1.12; letter-spacing: -0.02em; margin: 0; }
  h2 {
    color: var(--navy); font-size: 37px; font-weight: 800; letter-spacing: -0.02em;
    margin: 0.05em 0 0.5em; padding-bottom: 0.2em; border-bottom: 1.5px solid var(--line);
  }
  .kicker { display: block; text-transform: uppercase; letter-spacing: 0.13em; font-size: 14px; font-weight: 700; color: var(--accent); margin-bottom: 0.25em; }
  .lead { font-size: 23px; color: #2c2c2c; margin: 0 0 0.7em; }
  ul { list-style: none; padding: 0; margin: 0.2em 0; }
  li { position: relative; padding-left: 1.5em; margin: 0.55em 0; }
  li::before { content: "▪"; position: absolute; left: 0; top: 0; color: var(--navy); font-size: 0.9em; }
  ul ul { margin: 0.25em 0 0.1em; }
  ul ul li { margin: 0.2em 0; font-size: 0.92em; color: #3a3a3a; }
  ul ul li::before { content: "·"; color: var(--accent); }
  li b, li strong { color: var(--ink); font-weight: 800; }
  .d { color: var(--muted); font-weight: 400; }
  em { font-style: italic; color: var(--navy); }
  strong { color: var(--navy); }
  code { background: #eef0f6; color: var(--navy); padding: 1px 6px; border-radius: 5px; font-size: 0.84em; font-weight: 600; }
  .hero { display: block; margin: 12px auto 2px; height: 340px; }
  .cap { font-size: 18px; color: var(--muted); text-align: center; margin: 8px 0 0; }
  .num { color: var(--accent); font-weight: 800; }
  table { border-collapse: collapse; font-size: 19px; margin-top: 0.4em; }
  th { color: var(--navy); font-weight: 700; text-align: left; border-bottom: 1.5px solid var(--line); padding: 7px 16px 7px 0; }
  td { border-bottom: 1px solid var(--line); padding: 7px 16px 7px 0; }
  footer { color: #9aa0aa; font-size: 14px; }
  section::after { color: #9aa0aa; font-size: 14px; font-weight: 600; }
  section.title { justify-content: center; }
  section.title h1 { font-size: 45px; }
  section.title hr { border: none; border-top: 1.5px solid var(--navy); margin: 0.9em 0 0.7em; width: 100%; }
  section.title .who { font-size: 22px; font-weight: 700; color: var(--ink); margin: 0; }
  section.title .aff { font-size: 19px; color: var(--muted); margin: 0.15em 0 0; }
  section.title .pill { font-size: 16px; font-weight: 700; color: var(--accent); letter-spacing: 0.04em; margin: 1.1em 0 0; }
---

<!-- _class: title -->
<!-- _paginate: false -->
<!-- _footer: '' -->

# Ten(ders)Lens
## Un'architettura dati poliglotta per gli appalti pubblici italiani

<hr>

<p class="who">Youssef Bimezzagh</p>
<p class="aff">Università degli Studi di Milano-Bicocca · Laurea Magistrale in Informatica</p>
<p class="aff">Architetture Dati, a.a. 2025/2026</p>

<p class="pill">Scalabilità · Idempotenza · Ricerca vettoriale · Un agente che interroga i dati</p>

---

<span class="kicker">Il problema</span>
## Molti bandi, poca conoscenza

<p class="lead">Ogni anno in Italia vengono pubblicati centinaia di migliaia di bandi di gara, distribuiti su portali eterogenei e in un formato di difficile lettura. Monitorarli comporta un costo rilevante, in particolare per le piccole imprese.</p>

- **Individuare i bandi pertinenti è già un'operazione onerosa.**
- **Il quadro d'insieme resta implicito**<br><span class="d">quali operatori si aggiudicano sistematicamente le gare di un dato ente, quanto è concentrato un mercato: domande che l'analisi di una singola gara non consente di affrontare.</span>

<p class="lead">TenLens integra due dimensioni — il contenuto dei bandi e la rete degli aggiudicatari — rendendole interrogabili congiuntamente. La sua realizzazione su <strong>2,3 milioni di avvisi reali</strong> ha evidenziato quattro problemi concreti, oggetto di questa presentazione.</p>

---

<span class="kicker">Architettura</span>
## Tre database, un compito ciascuno

<p class="lead">Ciascun database assolve la funzione per cui è più adatto, sugli stessi dati di gara.</p>

- **MongoDB: lo store di riferimento**<br><span class="d">un documento completo per ogni gara, da cui si ricostruiscono gli altri due.</span>
- **Neo4j: le relazioni**<br><span class="d">la catena stazione appaltante → gara → aggiudicatario, per le interrogazioni di tipo relazionale.</span>
- **Elasticsearch: il significato**<br><span class="d">ricerca dei bandi per contenuto semantico, non per corrispondenza esatta.</span>

<p class="lead">Grafo e indice sono <em>proiezioni</em> derivate da MongoDB. La pipeline che li alimenta (<code>ingest → canonico → entità → embedding → sync</code>) è idempotente: una riesecuzione elabora soltanto i dati nuovi.</p>

---

<span class="kicker">Scalabilità · 1 di 3</span>
## Due regimi di costo al crescere dei dati

<p class="lead">Al crescere del dataset, la ricerca per <strong>CIG</strong> resta nell'ordine di 1-2 ms: l'indice opera in tempo logaritmico, indipendente dalla mole. Le aggregazioni che scandiscono <em>l'intera</em> collezione crescono invece linearmente con i dati (<span class="num">×4,4</span> dal 25% al 100%) e costituiscono, su una singola macchina, il collo di bottiglia.</p>

<img class="hero" src="../benchmarks/scale-data.png" alt="latenza al crescere del dataset">

<p class="cap">Lookup su indice (in basso): costante. Aggregazione full-scan (in alto): crescente con i dati.</p>

---

<span class="kicker">Scalabilità · 2 di 3</span>
## Distribuire il carico: lo sharding

<p class="lead">La soluzione consiste nel distribuire i dati su più nodi. Su un cluster dedicato (un droplet con <strong>4 vCPU e disco NVMe</strong>), portando lo sharding di MongoDB da 1 a 5 nodi, la latenza delle aggregazioni diminuisce del <span class="num">41%</span> e il throughput in scrittura aumenta del <span class="num">30%</span>, senza punti caldi. È una proprietà di MongoDB, che integra sharding e replica; Neo4j Community offre la sola alta disponibilità e non partiziona un grafo connesso su più nodi.</p>

<img class="hero" src="../benchmarks/scale-shard.png" alt="curva di sharding 1 a 5">

<p class="cap">Barre: throughput in scrittura (crescente). Linea: latenza dell'aggregazione (decrescente). Andamento monotòno su entrambi gli assi.</p>

---

<span class="kicker">Scalabilità · 3 di 3</span>
## Comportamento in caso di guasto

<p class="lead">Il nodo primario viene terminato di colpo durante la scrittura, a simulare un crash reale. Il cluster non lo rileva immediatamente: lo riconosce dopo il timeout dei battiti (~<span class="num">10 s</span>) e procede a eleggere un nuovo primario. Nell'intervallo le scritture si interrompono; le letture dai secondari proseguono.</p>

<img class="hero" src="../benchmarks/failover-window.png" alt="finestra di failover">

<p class="cap">36 mila scritture, 16 fallite, nessun dato perso; le letture non si interrompono.</p>

---

<span class="kicker">Idempotenza dell'ETL</span>
## Riesecuzione dell'ETL senza duplicati

<p class="lead">L'ETL non è un'operazione una tantum: i dati ANAC crescono e il caricamento va ripetuto con frequenza. Il vincolo è univoco: una riesecuzione non deve mai produrre un duplicato.</p>

- **Due fonti, un modello**<br><span class="d">Pubblicità Legale e OCDS presentano strutture diverse; un adattatore per fonte le riconduce al medesimo record canonico, rendendo la provenienza trasparente a valle.</span>
- **Il CIG come chiave naturale**<br><span class="d">la scrittura avviene in <em>upsert</em> sulla chiave: ricaricare una gara già presente la aggiorna anziché duplicarla. Una riesecuzione completa produce <span class="num">0 duplicati</span> su 2,4 milioni di record.</span>
- **La medesima chiave funge da join**<br><span class="d">una gara presente in entrambe le fonti confluisce in un unico record (22 mila gare); aggiudicazioni, rettifiche e ricorsi si accumulano sotto lo stesso CIG, ricomponendo la storia della gara.</span>

---

<span class="kicker">Idempotenza dell'ETL · le entità</span>
## Riconciliazione delle entità (record linkage)

<p class="lead">Problema analogo: una stessa impresa compare con denominazioni diverse e priva di un identificativo trasmesso via API. Stabilire quando due denominazioni indicano lo stesso soggetto è un problema di <em>record linkage</em>.</p>

- **Il fattore critico è il numero di confronti**<br><span class="d">il confronto esaustivo di ciascun soggetto con tutti gli altri richiederebbe <span class="num">91 miliardi</span> di coppie.</span>
- **Il blocking lo rende trattabile**<br><span class="d">i nomi simili vengono raggruppati in blocchi e confrontati solo internamente: i confronti scendono da 91 miliardi a <span class="num">94 mila</span>.</span>
- **La decisione si basa sul codice fiscale, non sul nome**<br><span class="d">precisione <span class="num">1,00</span> sul gold set. Si privilegia un collegamento mancato a uno errato: questi link alimentano segnalazioni di anomalia, in cui un falso positivo ha un costo elevato.</span>

---

<span class="kicker">Ricerca vettoriale</span>
## Ricerca per significato

<p class="lead">L'obiettivo è reperire un bando per <strong>contenuto semantico</strong>, non per corrispondenza letterale ("sfalcio" recupera "manutenzione del verde"). La scelta progettuale oppone la similarità esatta a forza bruta in MongoDB (precisa ma lineare) all'indice approssimato di Elasticsearch (rapido ma non esatto).</p>

<img class="hero" src="../benchmarks/search-tradeoff.png" alt="latenza e throughput, Mongo vs Elasticsearch">

<p class="cap">A 500 mila lotti: ~5 query/s con MongoDB, ~18 con Elasticsearch (4-5× più rapido), al prezzo di un recall intorno all'89%.</p>

---

<span class="kicker">Un agente che interroga i dati</span>
## Un agente sopra i tre database

<p class="lead">L'ultimo componente rende l'intero sistema interrogabile in linguaggio naturale: non un traduttore da testo a query, ma un <strong>agente che ragiona su più passi</strong>.</p>

- **Function-calling, fino a dieci passi**<br><span class="d">a ogni iterazione seleziona uno strumento, ne valuta il risultato e determina l'azione successiva, fino alla risposta.</span>
- **Dieci strumenti, distribuiti sui tre database**<br><span class="d">è qui che l'architettura poliglotta produce il proprio vantaggio: ogni domanda viene instradata al motore appropriato:</span>
  - il **grafo** per le relazioni,
  - **Elasticsearch** per il significato,
  - **MongoDB** per la scheda della gara.

<p class="lead">L'interrogazione avviene in italiano; la scelta di dove e come cercare è demandata all'agente.</p>

---

<span class="kicker">Un agente che interroga i dati · cosa sa fare</span>
## Dieci strumenti, una domanda alla volta

<p class="lead">Gli strumenti coprono i casi d'uso reali: alcuni restituiscono dati, altri producono un grafico o una rete esplorabile.</p>

- **Sul grafo**<br><span class="d">conteggi e classifiche, profilo di un'impresa, rete delle collaborazioni, metriche rese come grafico.</span>
- **Sul significato**<br><span class="d">ricerca dei bandi per tema, gare raggruppate per argomento.</span>
- **Sulla scheda e oltre**<br><span class="d">il dettaglio completo di una gara, la stima del prezzo di aggiudicazione atteso e la ricerca web per il contesto normativo.</span>

<p class="lead"><span class="d">Un ulteriore strumento risolve le denominazioni imprecise nelle entità esatte del grafo, evitando inferenze arbitrarie. Su un insieme di domande di prova, le risposte sono tutte corrette.</span></p>

---

<span class="kicker">L'agente al lavoro · ricerca per significato</span>
## "Cerca bandi per la manutenzione del verde pubblico"

<p class="lead">Senza parole chiave: l'agente ricerca per <strong>significato</strong> (embedding + kNN), recuperando gare formulate diversamente — "cura aree verdi", "sfalcio", "rigenerazione paesaggistica" — che una ricerca testuale non intercetterebbe. Ogni <strong>CIG è cliccabile</strong> e apre la scheda completa.</p>

<img class="hero" src="../img/chat-ricerca-semantica-verde.png" alt="esempio chat: ricerca semantica bandi verde pubblico">

<p class="cap">Ricerca vettoriale sui bandi: pertinenza per concetto, non per stringa. Risultati reali con importo e scadenza.</p>

---

<span class="kicker">L'agente al lavoro · un esempio reale</span>
## "Chi vince le gare dell'ASL di Pescara, e con che quota?"

<p class="lead">Una domanda in italiano. L'agente <strong>risolve la denominazione</strong> ("ASL di Pescara" → <em>Azienda Sanitaria Locale Pescara</em>, CF 01397530682), <strong>interroga il grafo</strong> e calcola la <strong>concentrazione di mercato</strong>: aggiudicatari, numero di gare e quota sul totale aggiudicato (<span class="num">117 M€</span>).</p>

<img class="hero" src="../img/chat-concentrazione-asl-pescara.png" alt="esempio chat: concentrazione di mercato ASL Pescara">

<p class="cap">Disambiguazione della denominazione, query sul grafo e aggregazione: tre passi per una sola domanda. È la lente sulle "red flag" di concentrazione.</p>

---

<span class="kicker">L'agente al lavoro · il quadro d'insieme</span>
## "Quali enti hanno una sola impresa che vince più della metà delle gare?"

<p class="lead">È una domanda a cui <strong>l'analisi di una singola gara non risponde</strong>: richiede di incrociare ente↔gara↔aggiudicatario sull'intero dataset. L'agente la traduce in una query sul grafo e individua i <strong>mercati di fatto monopolizzati</strong>, con ente, totale gare, impresa dominante e quota.</p>

<img class="hero" src="../img/chat-redflag-monopolisti.png" alt="esempio chat: enti con un'unica impresa che vince oltre la metà delle gare">

<p class="cap">Es. Comune di Pavone Canavese: 21 gare, COESA SRL ne vince 15 (71%). La lente sulle "red flag" di concentrazione, su scala nazionale.</p>

---

<span class="kicker">Conclusioni</span>
## Quattro scelte, quattro misure

<p class="lead">Ogni problema è stato chiuso con una misura, non con un'opinione; i limiti sono dichiarati, non taciuti.</p>

- **Scalabilità:** <span class="d">query su indice costanti, aggregazioni distribuite sugli shard (−41%), failover automatico senza perdita di dati.</span>
- **Idempotenza:** <span class="d">zero duplicati a scala piena; il CIG come chiave naturale e di join.</span>
- **Ricerca vettoriale:** <span class="d">l'esattezza di MongoDB contro la velocità di Elasticsearch, recall all'89%: compromesso dichiarato.</span>
- **L'agente:** <span class="d">dieci strumenti sopra i tre store, interrogabili in italiano.</span>

<p class="lead">Il filo conduttore è uno: <strong>ogni affermazione è sostenuta da una misura.</strong></p>
