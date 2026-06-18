import neo4j, { type Driver, type Integer } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "neo4j"
      )
    );
  }
  return driver;
}

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
};

/**
 * Esegue una query Cypher in SOLA LETTURA.
 * La sessione READ rifiuta qualunque scrittura (CREATE/DELETE/SET/MERGE) lato driver.
 */
export async function readCypher(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult> {
  const session = getDriver().session({
    database: process.env.NEO4J_DATABASE ?? "neo4j",
    defaultAccessMode: neo4j.session.READ,
  });
  try {
    // I numeri interi (es. LIMIT $limit = 10) vanno passati come Integer Neo4j,
    // altrimenti il driver li serializza come float (10.0) e Cypher rifiuta LIMIT/SKIP.
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      safe[k] = typeof v === "number" && Number.isInteger(v) ? neo4j.int(v) : v;
    }
    const res = await session.run(cypher, safe);
    const columns = res.records[0]?.keys.map(String) ?? [];
    const rows = res.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) {
        obj[String(key)] = normalize(r.get(key));
      }
      return obj;
    });
    return { columns, rows };
  } finally {
    await session.close();
  }
}

export type Candidato = {
  chiave: string;
  denominazione: string;
  tipo: "Impresa" | "Ente";
  nGare: number;
  score: number;
};

/**
 * Risolve un nome impreciso (refusi, troncamenti, maiuscole) nei candidati reali
 * usando il full-text index `entitaNomi` con ricerca fuzzy (suffisso `~` su ogni termine).
 * Ritorna i top 10 ordinati per score, a parità per nGare.
 * `chiave` è il cf per gli Ente, l'entityId (o denominazione) per le Imprese.
 */
export async function risolviEntita(
  nome: string,
  tipo?: "impresa" | "ente"
): Promise<Candidato[]> {
  // Tokenizza, scarta caratteri speciali Lucene, aggiunge fuzzy ~ a ogni termine.
  const termini = nome
    .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .map((t) => `${t}~`);
  if (termini.length === 0) return [];
  const q = termini.join(" AND ");

  const labelFilter =
    tipo === "impresa" ? "node:Impresa" : tipo === "ente" ? "node:Ente" : "true";

  const cypher = `
    CALL db.index.fulltext.queryNodes('entitaNomi', $q) YIELD node, score
    WHERE ${labelFilter}
    WITH node, score, head(labels(node)) AS tipo
    OPTIONAL MATCH (node)-[r:BANDISCE|VINCE]->(:Lotto)
    RETURN coalesce(node.cf, node.entityId, node.denominazione) AS chiave,
           node.denominazione AS denominazione,
           tipo,
           count(r) AS nGare,
           score
    ORDER BY score DESC, nGare DESC
    LIMIT 10`;

  const { rows } = await readCypher(cypher, { q });
  return rows as Candidato[];
}

export type GraphSchema = {
  nodi: { label: string; props: string[] }[];
  relazioni: { from: string; tipo: string; to: string }[];
};

/**
 * Introspezione live dello schema del grafo: label + proprietà e triple di
 * relazione (from)-[tipo]->(to). Sempre accurato perché letto da Neo4j.
 */
export async function schemaGrafo(): Promise<GraphSchema> {
  const props = await readCypher(`
    CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName
    WITH nodeLabels[0] AS label, collect(DISTINCT propertyName) AS props
    RETURN label, props ORDER BY label`);
  const rels = await readCypher(`
    CALL db.schema.visualization() YIELD relationships
    UNWIND relationships AS r
    RETURN DISTINCT startNode(r).name AS from, type(r) AS tipo, endNode(r).name AS to`);
  return {
    nodi: props.rows.map((r) => ({
      label: String(r.label),
      props: (r.props as string[]) ?? [],
    })),
    relazioni: rels.rows.map((r) => ({
      from: String(r.from),
      tipo: String(r.tipo),
      to: String(r.to),
    })),
  };
}

export type ReteResult = {
  centro: string;
  tipo: "ente" | "impresa";
  vicini: { label: string; peso: number; cf: string | null }[];
};

/**
 * Ego-network di un'entità: per un Ente, le imprese che vincono le sue gare;
 * per un'Impresa, gli enti da cui vince. Peso arco = n. gare in comune.
 */
export async function reteEntita(
  cf: string,
  tipo: "ente" | "impresa",
  limit = 12
): Promise<ReteResult> {
  const lim = Math.max(1, Math.floor(limit)); // LIMIT vuole un intero, non $param float
  const cypher =
    tipo === "ente"
      ? `MATCH (e:Ente {cf:$cf})-[:BANDISCE]->(:Lotto)<-[:VINCE]-(i:Impresa)
         WITH e, i, count(*) AS peso
         RETURN e.denominazione AS centro, i.denominazione AS label, i.cf AS cf, peso
         ORDER BY peso DESC LIMIT ${lim}`
      : `MATCH (i:Impresa {cf:$cf})-[:VINCE]->(:Lotto)<-[:BANDISCE]-(e:Ente)
         WITH i, e, count(*) AS peso
         RETURN i.denominazione AS centro, e.denominazione AS label, e.cf AS cf, peso
         ORDER BY peso DESC LIMIT ${lim}`;
  const { rows } = await readCypher(cypher, { cf });
  return {
    centro: rows[0]?.centro != null ? String(rows[0].centro) : cf,
    tipo,
    vicini: rows.map((r) => ({
      label: String(r.label),
      peso: Number(r.peso),
      cf: r.cf != null ? String(r.cf) : null,
    })),
  };
}

/** Converte i tipi Neo4j (Integer, Node, ecc.) in valori JSON semplici. */
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return (v as Integer).toNumber();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const node = v as { properties?: Record<string, unknown> };
    if (node.properties) return normalize(node.properties);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalize(val);
    }
    return out;
  }
  return v;
}
