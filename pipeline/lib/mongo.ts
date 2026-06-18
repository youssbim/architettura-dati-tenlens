import { MongoClient, type Db } from "mongodb";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB ?? "garagraph";

declare global {
  // eslint-disable-next-line no-var
  var __mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

function getClient(): Promise<MongoClient> {
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClient = new MongoClient(URI, {
      serverSelectionTimeoutMS: 5000,
    });
    globalThis.__mongoClientPromise = globalThis.__mongoClient.connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function db(): Promise<Db> {
  const client = await getClient();
  return client.db(DB_NAME);
}

export async function ping(): Promise<{ ok: true; database: string } | { ok: false; error: string }> {
  try {
    const d = await db();
    const res = await d.command({ ping: 1 });
    if (res.ok === 1) return { ok: true, database: DB_NAME };
    return { ok: false, error: "ping returned non-1 ok" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function closeClient(): Promise<void> {
  if (globalThis.__mongoClient) {
    await globalThis.__mongoClient.close();
    globalThis.__mongoClient = undefined;
    globalThis.__mongoClientPromise = undefined;
  }
}
