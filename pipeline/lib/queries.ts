// Query helpers per Neo4j + Mongo. Tutto server-side.

import { read } from "./neo4j";
import { db } from "./mongo";

export type Modalita =
  | "diretto"
  | "gara"
  | "negoziata"
  | "aperta"
  | "trasparenza"
  | "modifica"
  | "altro"
  | string;

export type AffidamentoRow = {
  idAppalto: string;
  oggetto: string | null;
  cig: string | null;
  modalita: Modalita | null;
  importo: number | null;
  data: string | null;
  saCf?: string;
  saDen?: string;
  impresaCf?: string;
  impresaDen?: string;
};

export type EntityRef = { cf: string; denominazione: string };

export async function getImpresa(cf: string): Promise<{
  cf: string;
  denominazione: string;
  denominazioneNormalizzata: string;
} | null> {
  const rows = await read<{
    cf: string;
    denominazione: string;
    denominazioneNormalizzata: string;
  }>(
    `MATCH (i:Impresa {cf: $cf})
     RETURN i.cf AS cf, i.denominazione AS denominazione,
            i.denominazioneNormalizzata AS denominazioneNormalizzata`,
    { cf },
  );
  return rows[0] ?? null;
}

export async function getStazione(cf: string): Promise<{
  cf: string;
  denominazione: string;
  denominazioneNormalizzata: string;
} | null> {
  const rows = await read<{
    cf: string;
    denominazione: string;
    denominazioneNormalizzata: string;
  }>(
    `MATCH (s:StazioneAppaltante {cf: $cf})
     RETURN s.cf AS cf, s.denominazione AS denominazione,
            s.denominazioneNormalizzata AS denominazioneNormalizzata`,
    { cf },
  );
  return rows[0] ?? null;
}

export async function affidamentiPerImpresa(
  cf: string,
  limit = 200,
): Promise<AffidamentoRow[]> {
  return read<AffidamentoRow>(
    `MATCH (i:Impresa {cf: $cf})<-[r:AGGIUDICATO_A]-(app:Appalto)
     OPTIONAL MATCH (app)<-[:RIGUARDA]-(av:Avviso)<-[:HA_PUBBLICATO]-(sa:StazioneAppaltante)
     RETURN DISTINCT
            app.idAppalto AS idAppalto,
            app.oggetto AS oggetto,
            app.cig AS cig,
            r.modalita AS modalita,
            r.importo AS importo,
            toString(coalesce(r.data, av.dataPubblicazione)) AS data,
            sa.cf AS saCf,
            sa.denominazione AS saDen
     ORDER BY CASE WHEN data IS NULL THEN 1 ELSE 0 END, data DESC
     LIMIT toInteger($limit)`,
    { cf, limit },
  );
}

export async function topClientiPerImpresa(
  cf: string,
  limit = 10,
): Promise<Array<{ saCf: string; saDen: string; totale: number; n: number }>> {
  return read(
    `MATCH (i:Impresa {cf: $cf})<-[r:AGGIUDICATO_A]-(:Appalto)<-[:RIGUARDA]-(:Avviso)<-[:HA_PUBBLICATO]-(sa:StazioneAppaltante)
     WITH sa, sum(coalesce(r.importo, 0)) AS totale, count(*) AS n
     RETURN sa.cf AS saCf, sa.denominazione AS saDen, totale, n
     ORDER BY totale DESC
     LIMIT toInteger($limit)`,
    { cf, limit },
  );
}

export async function affidamentiPerSa(
  cf: string,
  limit = 200,
): Promise<AffidamentoRow[]> {
  return read<AffidamentoRow>(
    `MATCH (sa:StazioneAppaltante {cf: $cf})-[:HA_PUBBLICATO]->(av:Avviso)-[:RIGUARDA]->(app:Appalto)
     OPTIONAL MATCH (app)-[r:AGGIUDICATO_A]->(imp:Impresa)
     RETURN DISTINCT
            app.idAppalto AS idAppalto,
            app.oggetto AS oggetto,
            app.cig AS cig,
            r.modalita AS modalita,
            r.importo AS importo,
            toString(coalesce(r.data, av.dataPubblicazione)) AS data,
            imp.cf AS impresaCf,
            imp.denominazione AS impresaDen
     ORDER BY CASE WHEN data IS NULL THEN 1 ELSE 0 END, data DESC
     LIMIT toInteger($limit)`,
    { cf, limit },
  );
}

export async function topFornitoriPerSa(
  cf: string,
  limit = 10,
): Promise<Array<{ impCf: string; impDen: string; totale: number; n: number }>> {
  return read(
    `MATCH (sa:StazioneAppaltante {cf: $cf})-[:HA_PUBBLICATO]->(:Avviso)-[:RIGUARDA]->(:Appalto)-[r:AGGIUDICATO_A]->(imp:Impresa)
     WITH imp, sum(coalesce(r.importo, 0)) AS totale, count(*) AS n
     RETURN imp.cf AS impCf, imp.denominazione AS impDen, totale, n
     ORDER BY totale DESC
     LIMIT toInteger($limit)`,
    { cf, limit },
  );
}

// ---------- Red flag findings ----------

export type RedFlagFinding = {
  _id: string;
  rule: string;
  ruleDescription: string;
  severity: "low" | "medium" | "high";
  description: string;
  entities: {
    sa?: EntityRef;
    impresa?: EntityRef;
    appalto?: { idAppalto: string; oggetto: string | null };
    appalti?: string[];
  };
  metrics: Record<string, unknown>;
  detectedAt: Date | string;
};

export async function getAllFindings(): Promise<RedFlagFinding[]> {
  const d = await db();
  const docs = (await d
    .collection("red_flag_findings")
    .find({})
    .sort({ severity: 1, detectedAt: -1 })
    .toArray()) as unknown as RedFlagFinding[];
  return docs.map((doc) => ({ ...doc, _id: String(doc._id) }));
}

export async function getFindingsByEntity(opts: {
  saCf?: string;
  impresaCf?: string;
}): Promise<RedFlagFinding[]> {
  const d = await db();
  const $or: Record<string, unknown>[] = [];
  if (opts.saCf) $or.push({ "entities.sa.cf": opts.saCf });
  if (opts.impresaCf) $or.push({ "entities.impresa.cf": opts.impresaCf });
  if (!$or.length) return [];
  const docs = (await d
    .collection("red_flag_findings")
    .find({ $or })
    .toArray()) as unknown as RedFlagFinding[];
  return docs.map((doc) => ({ ...doc, _id: String(doc._id) }));
}

// Used by the avviso detail page: returns the subset of (saCf, impresaCf) that exist as nodes.
export async function entitiesInGraph(cfs: string[]): Promise<{
  saCfs: Set<string>;
  impresaCfs: Set<string>;
}> {
  if (cfs.length === 0) return { saCfs: new Set(), impresaCfs: new Set() };
  const rows = await read<{ cf: string; type: "sa" | "imp" }>(
    `UNWIND $cfs AS cf
     OPTIONAL MATCH (sa:StazioneAppaltante {cf: cf})
     OPTIONAL MATCH (imp:Impresa {cf: cf})
     WITH cf, sa, imp
     WHERE sa IS NOT NULL OR imp IS NOT NULL
     RETURN cf,
            CASE WHEN sa IS NOT NULL THEN 'sa' ELSE 'imp' END AS type`,
    { cfs },
  );
  const saCfs = new Set<string>();
  const impresaCfs = new Set<string>();
  for (const r of rows) {
    if (r.type === "sa") saCfs.add(r.cf);
    else impresaCfs.add(r.cf);
  }
  return { saCfs, impresaCfs };
}
