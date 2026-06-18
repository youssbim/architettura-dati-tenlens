// Bootstrap indici Mongo per la chat persistence.

import { db, closeClient } from "../lib/mongo";

async function main(): Promise<void> {
  const d = await db();

  console.log("→ chats");
  const chats = d.collection("chats");
  await chats.createIndex({ updatedAt: -1 }, { name: "by_updated" });

  console.log("→ chat_messages");
  const msgs = d.collection("chat_messages");
  await msgs.createIndex({ chatId: 1, createdAt: 1 }, { name: "by_chat_time" });

  console.log("✓ done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
