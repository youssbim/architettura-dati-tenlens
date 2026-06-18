// Detection delle 9 red flag definite nel piano §5.
// Ogni regola = una funzione che esegue Cypher su Neo4j e produce findings.
// Tutti i finding vengono raccolti in MongoDB.red_flag_findings.
//
// Idempotente: drop+insert per regola, non duplicati su re-run.

import { read, closeDriver } from "../lib/neo4j";
import { db, closeClient } from "../lib/mongo";

// Esclude i valori palesemente bug-di-reporting OCDS (es. €6.7 miliardi su 1 affidamento)
const IMPORTO_OUTLIER_THRESHOLD = 500_000_000;

type Finding = {
  rule: string;
  ruleDescription: string;
  severity: "low" | "medium" | "high";
  description: string;
  entities: Record<string, unknown>;
  metrics: Record<string, unknown>;
  detectedAt: Date;
};

type Rule = {
  id: string;
  description: string;
  run: () => Promise<Finding[]>;
};

// --------------------------------------------------------------------------
// Rule 1 — Affidamento diretto ricorrente
// Stessa coppia (SA → Impresa) con ≥3 affidamenti diretti.
// --------------------------------------------------------------------------
const ruleDirettoRicorrente: Rule = {
  id: "diretto_ricorrente",
  description:
    "Stessa stazione appaltante affida ripetutamente alla stessa impresa via affidamento diretto",
  async run() {
    type Row = {
      saCf: string;
      saDen: string;
      impCf: string;
      impDen: string;
      n: number;
      totale: number;
      appalti: string[];
    };
    const rows = await read<Row>(
      `MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(av:Avviso)-[:RIGUARDA]->(app:Appalto)-[r:AGGIUDICATO_A]->(imp:Impresa)
       WHERE r.modalita = 'diretto'
       WITH sa, imp,
            count(DISTINCT app) AS n,
            collect(DISTINCT app.idAppalto) AS appalti,
            sum(coalesce(r.importo, 0)) AS totale
       WHERE n >= 3 AND totale < $cap
       RETURN sa.cf AS saCf, sa.denominazione AS saDen,
              imp.cf AS impCf, imp.denominazione AS impDen,
              n, totale, appalti
       ORDER BY n DESC, totale DESC`,
      { cap: IMPORTO_OUTLIER_THRESHOLD },
    );
    return rows.map<Finding>((r) => ({
      rule: ruleDirettoRicorrente.id,
      ruleDescription: ruleDirettoRicorrente.description,
      severity: r.n >= 5 ? "high" : "medium",
      description: `${r.impDen} ha ricevuto ${r.n} affidamenti diretti da ${r.saDen} (totale ${fmtEur(r.totale)})`,
      entities: {
        sa: { cf: r.saCf, denominazione: r.saDen },
        impresa: { cf: r.impCf, denominazione: r.impDen },
        appalti: r.appalti,
      },
      metrics: { affidamenti: r.n, totale: r.totale },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 2 — Splitting sotto-soglia
// Stessa coppia (SA → Impresa) con singoli affidamenti diretti < €40k
// ma somma > €40k → potenziale frazionamento per evitare la gara.
// --------------------------------------------------------------------------
const ruleSplitting: Rule = {
  id: "splitting_sottosoglia",
  description:
    "Più affidamenti diretti sotto-soglia che, sommati, superano la soglia di gara €40k",
  async run() {
    type Row = {
      saCf: string;
      saDen: string;
      impCf: string;
      impDen: string;
      n: number;
      totale: number;
      maxSingolo: number;
    };
    const rows = await read<Row>(
      `MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(av:Avviso)-[:RIGUARDA]->(app:Appalto)-[r:AGGIUDICATO_A]->(imp:Impresa)
       WHERE r.modalita = 'diretto' AND r.importo IS NOT NULL AND r.importo > 0 AND r.importo < 40000
       WITH sa, imp,
            count(DISTINCT app) AS n,
            sum(r.importo) AS totale,
            max(r.importo) AS maxSingolo
       WHERE n >= 2 AND totale > 40000 AND totale < $cap
       RETURN sa.cf AS saCf, sa.denominazione AS saDen,
              imp.cf AS impCf, imp.denominazione AS impDen,
              n, totale, maxSingolo
       ORDER BY totale DESC`,
      { cap: IMPORTO_OUTLIER_THRESHOLD },
    );
    return rows.map<Finding>((r) => ({
      rule: ruleSplitting.id,
      ruleDescription: ruleSplitting.description,
      severity: r.totale > 100000 ? "high" : "medium",
      description: `Frazionamento sospetto: ${r.impDen} ↔ ${r.saDen}: ${r.n} affidamenti sotto-soglia, totale ${fmtEur(r.totale)} (max singolo ${fmtEur(r.maxSingolo)})`,
      entities: {
        sa: { cf: r.saCf, denominazione: r.saDen },
        impresa: { cf: r.impCf, denominazione: r.impDen },
      },
      metrics: { numero: r.n, totale: r.totale, maxSingolo: r.maxSingolo },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 3 — Aggiudicatario locale dominante
// Un'impresa che vince > 50% degli appalti di una SA (con almeno 3 affidamenti totali).
// --------------------------------------------------------------------------
const ruleDominante: Rule = {
  id: "aggiudicatario_dominante",
  description: "Un'impresa cattura più del 50% degli affidamenti di una SA",
  async run() {
    type Row = {
      saCf: string;
      saDen: string;
      impCf: string;
      impDen: string;
      n: number;
      totSa: number;
      perc: number;
    };
    const rows = await read<Row>(
      `MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(:Avviso)-[:RIGUARDA]->(a:Appalto)-[:AGGIUDICATO_A]->(imp:Impresa)
       WITH sa, count(DISTINCT a) AS totSa
       WHERE totSa >= 3
       MATCH (sa)-[:HA_PUBBLICATO]->(:Avviso)-[:RIGUARDA]->(a:Appalto)-[:AGGIUDICATO_A]->(imp:Impresa)
       WITH sa, imp, totSa, count(DISTINCT a) AS n
       WITH sa, imp, n, totSa, toFloat(n) / totSa AS perc
       WHERE perc > 0.5
       RETURN sa.cf AS saCf, sa.denominazione AS saDen,
              imp.cf AS impCf, imp.denominazione AS impDen,
              n, totSa, perc
       ORDER BY perc DESC, n DESC`,
    );
    return rows.map<Finding>((r) => ({
      rule: ruleDominante.id,
      ruleDescription: ruleDominante.description,
      severity: r.perc > 0.8 ? "high" : "medium",
      description: `${r.impDen} vince ${(r.perc * 100).toFixed(1)}% degli affidamenti (${r.n} su ${r.totSa}) di ${r.saDen}`,
      entities: {
        sa: { cf: r.saCf, denominazione: r.saDen },
        impresa: { cf: r.impCf, denominazione: r.impDen },
      },
      metrics: { affidamenti: r.n, totaleSa: r.totSa, percentuale: r.perc },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 4 — Rettifiche eccessive
// Un Appalto con > 3 rettifiche → specifiche probabilmente confuse o cambi tardivi.
// --------------------------------------------------------------------------
const ruleRettificheEccessive: Rule = {
  id: "rettifiche_eccessive",
  description: "Un Appalto con più di 3 avvisi successivi (rettifiche)",
  async run() {
    type Row = {
      idAppalto: string;
      oggetto: string;
      n: number;
    };
    const rows = await read<Row>(
      `MATCH (a:Appalto)<-[:RIGUARDA]-(av:Avviso)
       WITH a, count(av) AS n
       WHERE n > 3
       RETURN a.idAppalto AS idAppalto, a.oggetto AS oggetto, n
       ORDER BY n DESC`,
    );
    return rows.map<Finding>((r) => ({
      rule: ruleRettificheEccessive.id,
      ruleDescription: ruleRettificheEccessive.description,
      severity: r.n > 6 ? "high" : "medium",
      description: `Appalto con ${r.n} avvisi successivi: ${r.oggetto ?? r.idAppalto}`,
      entities: { appalto: { idAppalto: r.idAppalto, oggetto: r.oggetto } },
      metrics: { avvisi: r.n },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 5 — Modifica contratto > 20% (semplificato)
// In assenza del bridge CIG completo, conta appalti che HANNO un avviso di
// modifica del contratto (codiceScheda M1/M2). Versione completa (delta importi)
// arriverà quando si chiude il bridge OCDS↔PL.
// --------------------------------------------------------------------------
const ruleModificaContratto: Rule = {
  id: "modifica_contratto",
  description:
    "Appalto con almeno un avviso di modifica del contratto (M1/M2 ex art. 132 D.Lgs 36/2023)",
  async run() {
    type Row = {
      idAppalto: string;
      oggetto: string;
      n: number;
    };
    const rows = await read<Row>(
      `MATCH (a:Appalto)<-[:RIGUARDA]-(av:Avviso)
       WHERE av.codiceScheda IN ['M1','M1_40','M2','M2_40']
       WITH a, count(av) AS n
       RETURN a.idAppalto AS idAppalto, a.oggetto AS oggetto, n
       ORDER BY n DESC`,
    );
    return rows.map<Finding>((r) => ({
      rule: ruleModificaContratto.id,
      ruleDescription: ruleModificaContratto.description,
      severity: r.n > 1 ? "high" : "low",
      description: `Appalto con ${r.n} modifica/e di contratto: ${r.oggetto ?? r.idAppalto}`,
      entities: { appalto: { idAppalto: r.idAppalto, oggetto: r.oggetto } },
      metrics: { modifiche: r.n },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 6 — Trasparenza preventiva sospetta
// Stessa coppia (SA, Impresa) con avviso di trasparenza preventiva (A7_1_x, AD1_25-28)
// E avviso di affidamento diretto (AD3 o A3_6) — pattern classico di pre-annuncio
// con destinatario già scelto.
// --------------------------------------------------------------------------
const ruleTrasparenzaSospetta: Rule = {
  id: "trasparenza_sospetta",
  description:
    "Coppia SA-Impresa con avviso di trasparenza preventiva seguito da affidamento diretto",
  async run() {
    type Row = {
      saCf: string;
      saDen: string;
      impCf: string;
      impDen: string;
      avvisiTrasp: number;
      avvisiDiretto: number;
    };
    const rows = await read<Row>(
      `MATCH (sa:StazioneAppaltante)-[:HA_PUBBLICATO]->(av:Avviso)-[:RIGUARDA]->(:Appalto)-[:AGGIUDICATO_A]->(imp:Impresa)
       WITH sa, imp,
            sum(CASE WHEN av.codiceScheda IN ['A7_1_1','AD1_25','AD1_26','AD1_27','AD1_28'] THEN 1 ELSE 0 END) AS avvisiTrasp,
            sum(CASE WHEN av.codiceScheda IN ['AD3','A3_6'] THEN 1 ELSE 0 END) AS avvisiDiretto
       WHERE avvisiTrasp > 0 AND avvisiDiretto > 0
       RETURN sa.cf AS saCf, sa.denominazione AS saDen,
              imp.cf AS impCf, imp.denominazione AS impDen,
              avvisiTrasp, avvisiDiretto
       ORDER BY avvisiDiretto DESC, avvisiTrasp DESC`,
    );
    return rows.map<Finding>((r) => ({
      rule: ruleTrasparenzaSospetta.id,
      ruleDescription: ruleTrasparenzaSospetta.description,
      severity: "medium",
      description: `${r.impDen} ↔ ${r.saDen}: ${r.avvisiTrasp} avvisi trasparenza preventiva + ${r.avvisiDiretto} affidamenti diretti`,
      entities: {
        sa: { cf: r.saCf, denominazione: r.saDen },
        impresa: { cf: r.impCf, denominazione: r.impDen },
      },
      metrics: {
        trasparenza: r.avvisiTrasp,
        diretti: r.avvisiDiretto,
      },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 7 — Cattura del cliente
// Un'impresa con ≥ 70% del proprio importo aggiudicato proveniente da una sola SA,
// con almeno 3 affidamenti totali e totale > €10k.
// --------------------------------------------------------------------------
const ruleCattura: Rule = {
  id: "cattura_cliente",
  description:
    "Un'impresa dipende per >70% dell'importo aggiudicato da una sola SA",
  async run() {
    type Row = {
      impCf: string;
      impDen: string;
      saCf: string;
      saDen: string;
      impTot: number;
      saTot: number;
      perc: number;
      n: number;
    };
    const rows = await read<Row>(
      `MATCH (imp:Impresa)<-[r:AGGIUDICATO_A]-(:Appalto)<-[:RIGUARDA]-(:Avviso)<-[:HA_PUBBLICATO]-(sa:StazioneAppaltante)
       WHERE r.importo IS NOT NULL AND r.importo > 0 AND r.importo < $cap
       WITH imp,
            sum(r.importo) AS impTot,
            count(DISTINCT sa) AS distinctSa,
            collect({sa: sa, importo: r.importo}) AS pairs
       WHERE impTot > 10000 AND distinctSa >= 1
       UNWIND pairs AS pair
       WITH imp, impTot, pair.sa AS sa, sum(pair.importo) AS saTot, count(pair) AS n
       WITH imp, impTot, sa, saTot, n, toFloat(saTot) / impTot AS perc
       WHERE perc >= 0.7 AND n >= 3
       RETURN imp.cf AS impCf, imp.denominazione AS impDen,
              sa.cf AS saCf, sa.denominazione AS saDen,
              impTot, saTot, perc, n
       ORDER BY perc DESC, saTot DESC`,
      { cap: IMPORTO_OUTLIER_THRESHOLD },
    );
    return rows.map<Finding>((r) => ({
      rule: ruleCattura.id,
      ruleDescription: ruleCattura.description,
      severity: r.perc >= 0.9 ? "high" : "medium",
      description: `${r.impDen} riceve ${(r.perc * 100).toFixed(1)}% del proprio fatturato pubblico (${fmtEur(r.saTot)}/${fmtEur(r.impTot)}) da ${r.saDen}`,
      entities: {
        impresa: { cf: r.impCf, denominazione: r.impDen },
        sa: { cf: r.saCf, denominazione: r.saDen },
      },
      metrics: {
        importoVersoSa: r.saTot,
        importoTotale: r.impTot,
        percentuale: r.perc,
        affidamenti: r.n,
      },
      detectedAt: new Date(),
    }));
  },
};

// --------------------------------------------------------------------------
// Rule 8 — Sub-rete chiusa (Louvain)
// Implementata da scripts/gds-louvain.ts (chiamabile via `npm run gds:louvain`).
// Qui restituiamo solo i finding già materializzati per non rimaneggiare la
// graph projection (operazione costosa).
// --------------------------------------------------------------------------
const ruleSubreteChiusa: Rule = {
  id: "subrete_chiusa",
  description: "Sub-rete densa SA-Impresa identificata via Louvain",
  async run() {
    // Le finding sono prodotte da gds-louvain.ts; il runner di red-flag.ts
    // non sovrascrive (vedi delete-then-insert logic).
    return [];
  },
};

const RULES: Rule[] = [
  ruleDirettoRicorrente,
  ruleSplitting,
  ruleDominante,
  ruleRettificheEccessive,
  ruleModificaContratto,
  ruleTrasparenzaSospetta,
  ruleCattura,
  ruleSubreteChiusa,
];

function fmtEur(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("it-IT", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const d = await db();
  const col = d.collection("red_flag_findings");
  await col.createIndex({ rule: 1 }, { name: "by_rule" });
  await col.createIndex({ severity: 1 }, { name: "by_severity" });
  await col.createIndex({ detectedAt: -1 }, { name: "by_date" });

  console.log(`→ red-flag: eseguo ${RULES.length} regole\n`);

  let totalFindings = 0;
  for (const rule of RULES) {
    const t1 = Date.now();
    const findings = await rule.run();
    // subrete_chiusa è prodotta da gds-louvain.ts, qui non sovrascrivo
    if (rule.id !== "subrete_chiusa") {
      await col.deleteMany({ rule: rule.id });
      if (findings.length > 0) {
        await col.insertMany(findings);
      }
    }
    const ms = Date.now() - t1;
    const tag = findings.length === 0 ? "—" : findings.length.toString();
    console.log(
      `  ${rule.id.padEnd(28)} ${tag.padStart(5)} finding   (${ms}ms)`,
    );
    totalFindings += findings.length;
  }

  console.log(
    `\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalFindings} finding totali`,
  );
}

main()
  .catch((e) => {
    console.error("\n✗ red-flag failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closeClient();
  });
