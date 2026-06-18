"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const THINKING_PHRASES = [
  "Sto pensando…",
  "Rifletto…",
  "Analizzo…",
  "Valuto…",
  "Ragiono…",
];

function Spinner() {
  return (
    <span className="h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
  );
}

/** Indicatore di attesa: mostrato finché l'assistente non emette testo. */
export function ThinkingIndicator() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % THINKING_PHRASES.length), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex w-full items-center gap-2 text-sm text-zinc-500">
      <Spinner />
      <span className="italic">{THINKING_PHRASES[i]}</span>
    </div>
  );
}

const COLLAPSED_MAX_LINES = 6;
const COLLAPSED_MAX_HEIGHT_REM = 9;

/** Blocco "ragionamento" collassabile (adattato da willchen96/mike). */
export function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [isContentOpen, setIsContentOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [hasMeasured, setHasMeasured] = useState(false);
  const [i, setI] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const t = setInterval(() => setI((v) => (v + 1) % THINKING_PHRASES.length), 2000);
    return () => clearInterval(t);
  }, [isStreaming]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const next = el.scrollHeight > lh * COLLAPSED_MAX_LINES + 2;
    setIsOverflowing(next);
    setHasMeasured(true);
    if (!userToggled) setIsContentOpen(isStreaming);
    if (!next) setIsExpanded(false);
  }, [isStreaming, text, userToggled]);

  const showContent = isContentOpen || isStreaming || !hasMeasured;
  const isCollapsed = isContentOpen && isOverflowing && !isExpanded;

  return (
    <div className="relative">
      <button
        onClick={() => {
          if (isStreaming) return;
          setUserToggled(true);
          setIsContentOpen((v) => !v);
        }}
        className="flex items-center text-sm text-zinc-500 transition-colors hover:text-zinc-700"
      >
        {isStreaming ? (
          <Spinner />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />
        )}
        <span className="ml-2 font-medium italic">
          {isStreaming ? THINKING_PHRASES[i] : "Ragionamento"}
        </span>
        {!isStreaming && (
          <ChevronDown
            size={11}
            className={`relative top-px ml-1 transition-transform duration-200 ${
              isContentOpen ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>

      {showContent && text && (
        <div className="ml-[14px] mt-2">
          <div
            className={`relative ${isCollapsed ? "overflow-hidden" : ""}`}
            style={isCollapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT_REM}rem` } : undefined}
          >
            <div
              ref={contentRef}
              className="prose prose-sm max-w-none text-sm text-zinc-400 [&>*]:text-sm [&>*]:text-zinc-400"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
            {isCollapsed && (
              <>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-white dark:to-zinc-900" />
                <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 text-zinc-400 transition-colors hover:text-zinc-600"
                  aria-label="Espandi ragionamento"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
          {isOverflowing && isContentOpen && isExpanded && (
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="mx-auto mt-2 flex text-zinc-400 transition-colors hover:text-zinc-600"
              aria-label="Riduci ragionamento"
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-180" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
