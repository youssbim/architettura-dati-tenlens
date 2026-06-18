import neo4j, { type Driver, type Session, type RecordShape } from "neo4j-driver";

const URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const USER = process.env.NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD ?? "garagraph_dev";
const DATABASE = process.env.NEO4J_DATABASE ?? "neo4j";

declare global {
  // eslint-disable-next-line no-var
  var __neo4jDriver: Driver | undefined;
}

function buildDriver(): Driver {
  return neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD), {
    maxConnectionPoolSize: 30,
    connectionAcquisitionTimeout: 15000,
    // Validate idle pool entries older than 5s before handing them out.
    // Without this, stale sockets from a Neo4j restart linger in the pool
    // and surface as ECONNRESET on the next query.
    connectionLivenessCheckTimeout: 5000,
    disableLosslessIntegers: true,
  });
}

function getDriver(): Driver {
  if (!globalThis.__neo4jDriver) {
    globalThis.__neo4jDriver = buildDriver();
  }
  return globalThis.__neo4jDriver;
}

async function resetDriver(): Promise<void> {
  const old = globalThis.__neo4jDriver;
  globalThis.__neo4jDriver = undefined;
  if (old) {
    try {
      await old.close();
    } catch {
      // throwing it away anyway
    }
  }
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ECONNREFUSED|Connection was closed|Connection acquisition timed out|Failed to connect/i.test(
    msg,
  );
}

export type Params = Record<string, unknown>;

async function runSession<T extends RecordShape>(
  mode: "READ" | "WRITE",
  cypher: string,
  params: Params,
): Promise<T[]> {
  const session: Session = getDriver().session({
    database: DATABASE,
    defaultAccessMode:
      mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const res = await session.run<T>(cypher, params);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    // Stale driver / pool — recreate and retry once.
    await resetDriver();
    return await fn();
  }
}

export async function read<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Params = {},
): Promise<T[]> {
  return withRetry(() => runSession<T>("READ", cypher, params));
}

export async function write<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Params = {},
): Promise<T[]> {
  return withRetry(() => runSession<T>("WRITE", cypher, params));
}

export async function ping(): Promise<
  { ok: true; address: string } | { ok: false; error: string }
> {
  try {
    const records = await read<{ value: number }>("RETURN 1 AS value", {});
    if (records[0]?.value === 1) {
      return { ok: true, address: URI };
    }
    return { ok: false, error: "no result" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function closeDriver(): Promise<void> {
  await resetDriver();
}
