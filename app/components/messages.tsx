"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import type { UIMessage } from "ai";
import { cn } from "@/lib/utils";
import { FileText, Globe } from "lucide-react";
import { ReasoningBlock } from "@/components/reasoning";
import { ToolBlock } from "@/components/tool-block";
import { useBando } from "@/components/bando-panel";
import { useWeb, WebChip } from "@/components/web-panel";
import { ChartCard } from "@/components/chart-card";
import { NetworkCard } from "@/components/network-card";

/**
 * Link nel testo finale dell'assistente:
 * - href "cig:XXXX"  → apre la scheda bando nel pannello laterale
 * - href http(s)     → apre la pagina nell'iframe interno (non esce dalla chat)
 * Le componenti UI compaiono SOLO qui, se il modello le cita nel testo.
 */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { open: openBando } = useBando();
  const { open: openWeb } = useWeb();
  if (!href) return <span>{children}</span>;

  if (href.startsWith("cig:")) {
    const cig = href.slice(4);
    return (
      <button
        type="button"
        onClick={() => openBando(cig)}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 align-baseline text-xs font-medium text-zinc-700 no-underline transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      >
        <FileText className="h-3 w-3 text-zinc-400" />
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openWeb(href)}
      className="inline items-center text-left text-blue-600 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400"
    >
      <Globe className="mr-0.5 inline h-3 w-3 align-[-1px] text-blue-400" />
      {children}
    </button>
  );
}

function textOf(message: UIMessage) {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

function reasoningOf(message: UIMessage) {
  return message.parts
    .filter((p) => p.type === "reasoning")
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

function toolPartsOf(message: UIMessage) {
  return message.parts.filter((p) => p.type.startsWith("tool-"));
}

/** URL delle fonti web restituite da cercaWeb in questo messaggio. */
function webSourcesOf(message: UIMessage): string[] {
  const urls: string[] = [];
  for (const p of message.parts) {
    if (!p.type.startsWith("tool-")) continue;
    if (!p.type.includes("cercaWeb") && !p.type.includes("web_search")) continue;
    const out = (p as { output?: unknown }).output as Record<string, unknown> | undefined;
    const sources = out?.sources;
    if (Array.isArray(sources)) {
      for (const s of sources) {
        const u = (s as Record<string, unknown>)?.url;
        if (typeof u === "string") urls.push(u);
      }
    }
  }
  return Array.from(new Set(urls));
}

/** Grafici prodotti dal tool metriche in questo messaggio. */
type ChartSpec = { titolo?: string; tipo?: string; rows: Record<string, unknown>[] };
function chartsOf(message: UIMessage): ChartSpec[] {
  const out: ChartSpec[] = [];
  for (const p of message.parts) {
    if (!p.type.startsWith("tool-") || !p.type.includes("metriche")) continue;
    const o = (p as { output?: unknown }).output as Record<string, unknown> | undefined;
    if (o?.ok && Array.isArray(o.rows) && o.rows.length) {
      out.push({
        titolo: typeof o.titolo === "string" ? o.titolo : undefined,
        tipo: typeof o.tipo === "string" ? o.tipo : undefined,
        rows: o.rows as Record<string, unknown>[],
      });
    }
  }
  return out;
}

/** Reti (ego-network) prodotte dal tool reteEntita in questo messaggio. */
type NetSpec = { centro: string; tipo?: string; vicini: { label: string; peso: number }[] };
function networksOf(message: UIMessage): NetSpec[] {
  const out: NetSpec[] = [];
  for (const p of message.parts) {
    if (!p.type.startsWith("tool-") || !p.type.includes("reteEntita")) continue;
    const o = (p as { output?: unknown }).output as Record<string, unknown> | undefined;
    if (o?.ok && Array.isArray(o.vicini) && o.vicini.length) {
      out.push({
        centro: String(o.centro ?? ""),
        tipo: typeof o.tipo === "string" ? o.tipo : undefined,
        vicini: o.vicini as { label: string; peso: number }[],
      });
    }
  }
  return out;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-400 opacity-0 transition-all hover:bg-zinc-900/5 hover:text-zinc-600 group-hover:opacity-100 dark:hover:bg-white/10"
      aria-label="Copia"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copiato" : "Copia"}
    </button>
  );
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex w-full justify-end">
      <div className="max-w-[80%] rounded-2xl bg-gray-100 px-4 py-3 dark:bg-zinc-800">
        <p className="whitespace-pre-wrap text-sm text-gray-900 dark:text-zinc-100">
          {content}
        </p>
      </div>
    </div>
  );
}

export function AssistantMessage({
  content,
  reasoning,
  toolParts,
  webSources,
  charts,
  networks,
  isStreaming,
}: {
  content: string;
  reasoning?: string;
  toolParts?: { type: string }[];
  webSources?: string[];
  charts?: ChartSpec[];
  networks?: NetSpec[];
  isStreaming: boolean;
}) {
  const reasoningStreaming = isStreaming && !content;
  // Fonti web che l'AI ha effettivamente CITATO nel testo (match per dominio).
  const citate = (webSources ?? []).filter((u) => {
    const h = hostOf(u);
    return h && content.toLowerCase().includes(h.toLowerCase());
  });
  return (
    <div className="group flex w-full flex-col items-start gap-2">
      {(reasoning || reasoningStreaming) && (
        <ReasoningBlock text={reasoning ?? ""} isStreaming={reasoningStreaming} />
      )}
      {toolParts && toolParts.length > 0 && (
        <div className="flex w-full flex-col gap-1.5">
          {toolParts.map((p, i) => (
            <ToolBlock key={i} part={p} />
          ))}
        </div>
      )}
      {content && (
        <div
          className={cn(
            "prose prose-sm prose-zinc max-w-[88%] dark:prose-invert",
            "prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none"
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ a: MdLink }}
            urlTransform={(url) => url}
          >
            {content}
          </ReactMarkdown>
        </div>
      )}
      {!isStreaming && charts && charts.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          {charts.map((c, i) => (
            <ChartCard key={i} titolo={c.titolo} tipo={c.tipo} rows={c.rows} />
          ))}
        </div>
      )}
      {!isStreaming && networks && networks.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          {networks.map((n, i) => (
            <NetworkCard key={i} centro={n.centro} tipo={n.tipo} vicini={n.vicini} />
          ))}
        </div>
      )}
      {!isStreaming && citate.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {citate.map((u) => (
            <WebChip key={u} url={u} />
          ))}
        </div>
      )}
      {content && !isStreaming && <CopyButton text={content} />}
    </div>
  );
}

export function Message({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  if (message.role === "user") {
    return <UserMessage content={textOf(message)} />;
  }
  return (
    <AssistantMessage
      content={textOf(message)}
      reasoning={reasoningOf(message)}
      toolParts={toolPartsOf(message)}
      webSources={webSourcesOf(message)}
      charts={chartsOf(message)}
      networks={networksOf(message)}
      isStreaming={isStreaming}
    />
  );
}
