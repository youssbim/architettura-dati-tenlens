// Storage + helpers per la chat history.

import { db } from "./mongo";
import { ObjectId } from "mongodb";

export type Role = "user" | "assistant";

export type ChatMessageRow = {
  _id: string;
  chatId: string;
  role: Role;
  parts: unknown[]; // UIMessage parts (text + tool calls)
  createdAt: Date;
};

export type ChatRow = {
  _id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
};

export async function listChats(limit = 50): Promise<ChatRow[]> {
  const d = await db();
  const docs = await d
    .collection("chats")
    .find({})
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map((doc) => ({
    _id: String(doc._id),
    title: doc.title ?? "(senza titolo)",
    createdAt: doc.createdAt ?? new Date(),
    updatedAt: doc.updatedAt ?? new Date(),
    messageCount: doc.messageCount ?? 0,
  }));
}

export async function createChat(initialTitle = "Nuova chat"): Promise<string> {
  const d = await db();
  const now = new Date();
  const res = await d.collection("chats").insertOne({
    title: initialTitle,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  });
  return String(res.insertedId);
}

export async function getChat(id: string): Promise<ChatRow | null> {
  const d = await db();
  let _id: ObjectId;
  try {
    _id = new ObjectId(id);
  } catch {
    return null;
  }
  const doc = await d.collection("chats").findOne({ _id });
  if (!doc) return null;
  return {
    _id: String(doc._id),
    title: doc.title ?? "(senza titolo)",
    createdAt: doc.createdAt ?? new Date(),
    updatedAt: doc.updatedAt ?? new Date(),
    messageCount: doc.messageCount ?? 0,
  };
}

export async function deleteChat(id: string): Promise<boolean> {
  const d = await db();
  let _id: ObjectId;
  try {
    _id = new ObjectId(id);
  } catch {
    return false;
  }
  await d.collection("chat_messages").deleteMany({ chatId: id });
  const res = await d.collection("chats").deleteOne({ _id });
  return res.deletedCount > 0;
}

export async function listMessages(chatId: string): Promise<ChatMessageRow[]> {
  const d = await db();
  const docs = await d
    .collection("chat_messages")
    .find({ chatId })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((doc) => ({
    _id: String(doc._id),
    chatId: doc.chatId,
    role: doc.role,
    parts: Array.isArray(doc.parts) ? doc.parts : [],
    createdAt: doc.createdAt,
  }));
}

export async function appendMessage(
  chatId: string,
  role: Role,
  parts: unknown[],
): Promise<string> {
  const d = await db();
  const now = new Date();
  const res = await d.collection("chat_messages").insertOne({
    chatId,
    role,
    parts,
    createdAt: now,
  });
  let _id: ObjectId;
  try {
    _id = new ObjectId(chatId);
    await d.collection("chats").updateOne(
      { _id },
      { $set: { updatedAt: now }, $inc: { messageCount: 1 } },
    );
  } catch {
    // chatId invalid — ignore
  }
  return String(res.insertedId);
}

export async function updateChatTitle(
  chatId: string,
  title: string,
): Promise<void> {
  const d = await db();
  let _id: ObjectId;
  try {
    _id = new ObjectId(chatId);
  } catch {
    return;
  }
  await d
    .collection("chats")
    .updateOne({ _id }, { $set: { title, updatedAt: new Date() } });
}
