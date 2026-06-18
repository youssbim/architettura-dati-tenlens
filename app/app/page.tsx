"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef } from "react";
import { SquarePen } from "lucide-react";
import { Message } from "@/components/messages";
import { ChatInput } from "@/components/chat-input";
import { SiteLogo } from "@/components/site-logo";
import { Suggestions } from "@/components/suggestions";
import { ThinkingIndicator } from "@/components/reasoning";
import { BandoProvider } from "@/components/bando-panel";
import { WebProvider } from "@/components/web-panel";

export default function Chat() {
  const { messages, sendMessage, setMessages, status, stop } = useChat();
  const busy = status === "streaming" || status === "submitted";
  const empty = messages.length === 0;
  const last = messages[messages.length - 1];
  const showThinking =
    status === "submitted" && (!last || last.role === "user");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  return (
    <WebProvider>
    <BandoProvider>
    <div className="relative flex h-screen flex-col bg-gradient-to-b from-zinc-50 via-white to-zinc-100 dark:from-zinc-950 dark:via-zinc-900 dark:to-black">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200/70 bg-white/40 px-4 py-3 backdrop-blur-xl dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <SiteLogo size="sm" />
          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={empty || busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-900/5 hover:text-zinc-800 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <SquarePen className="h-4 w-4" />
            <span className="hidden sm:inline">Nuova chat</span>
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-8 px-4 pb-16">
            <div className="flex flex-col items-center gap-3 text-center">
              <SiteLogo size="lg" />
              <p className="text-sm text-zinc-400">
                Assistente per l&apos;analisi degli appalti pubblici italiani.
              </p>
            </div>
            <Suggestions onPick={(text) => sendMessage({ text })} />
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
            {messages.map((message, idx) => (
              <Message
                key={message.id}
                message={message}
                isStreaming={status === "streaming" && idx === messages.length - 1}
              />
            ))}
            {showThinking && <ThinkingIndicator />}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 px-4 pb-6 pt-2">
        <div className="mx-auto max-w-3xl">
          <ChatInput
            isLoading={busy}
            onCancel={stop}
            onSubmit={(text) => sendMessage({ text })}
          />
        </div>
      </div>
    </div>
    </BandoProvider>
    </WebProvider>
  );
}
