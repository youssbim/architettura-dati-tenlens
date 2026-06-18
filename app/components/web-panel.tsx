"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Globe, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

type WebCtx = { open: (url: string) => void };
const Ctx = createContext<WebCtx | null>(null);

export function useWeb() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWeb deve stare dentro <WebProvider>");
  return c;
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Chip cliccabile di una fonte web. */
export function WebChip({ url }: { url: string }) {
  const { open } = useWeb();
  return (
    <button
      type="button"
      onClick={() => open(url)}
      className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-xs text-zinc-700 shadow-sm transition-all hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <span className="truncate">{host(url)}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500" />
    </button>
  );
}

export function WebProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const open = useCallback((u: string) => setUrl(u), []);
  const close = useCallback(() => setUrl(null), []);

  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url, close]);

  return (
    <Ctx.Provider value={{ open }}>
      {children}

      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity",
          url ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={close}
      />

      <aside
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950",
          url ? "translate-x-0" : "translate-x-full"
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-2">
            <Globe className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
              {url ? host(url) : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                aria-label="Apri in una nuova scheda"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
              aria-label="Chiudi"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="relative flex-1 bg-zinc-50 dark:bg-zinc-900">
          {url && (
            <iframe
              key={url}
              src={`/api/proxy?url=${encodeURIComponent(url)}`}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-popups allow-forms"
              referrerPolicy="no-referrer"
            />
          )}
          {/* Fallback: alcuni siti bloccano l'embedding (X-Frame-Options). */}
          {url && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900/80 px-3 py-1 text-xs text-white">
              Se la pagina resta vuota, il sito blocca l&apos;embedding —{" "}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto underline"
              >
                aprila in una scheda
              </a>
            </div>
          )}
        </div>
      </aside>
    </Ctx.Provider>
  );
}
