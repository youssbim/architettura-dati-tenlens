"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

type ToolPart = {
  type: string; // es. "tool-queryGrafo" | "tool-risolviEntita"
  state?: string; // input-streaming | input-available | output-available | output-error
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function Dot({ state }: { state: "run" | "ok" | "err" }) {
  if (state === "run")
    return (
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
    );
  return (
    <span
      className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
        state === "err" ? "bg-red-400" : "bg-emerald-400"
      }`}
    />
  );
}

/** Etichetta + dettaglio per ciascun tool. */
function describe(part: ToolPart): {
  running: string;
  done: string;
  detail?: string;
} {
  const name = part.type.replace(/^tool-/, "");
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = (part.output ?? {}) as Record<string, unknown>;

  if (name === "risolviEntita") {
    const nome = typeof input.nome === "string" ? input.nome : "…";
    const count = typeof output.count === "number" ? output.count : undefined;
    return {
      running: `Risolvo «${nome}»`,
      done:
        count !== undefined
          ? `Risolto «${nome}» — ${count} candidati`
          : `Risolto «${nome}»`,
    };
  }

  if (name === "schemaGrafo") {
    return { running: "Esploro lo schema del grafo", done: "Schema del grafo esplorato" };
  }

  if (name === "ricercaSemantica") {
    const q = typeof input.query === "string" ? input.query : "…";
    const count = typeof output.count === "number" ? output.count : undefined;
    return {
      running: `Ricerca semantica «${q}»`,
      done:
        count !== undefined
          ? `Ricerca semantica «${q}» — ${count} bandi`
          : `Ricerca semantica «${q}»`,
    };
  }

  if (name === "dettaglioBando") {
    const cig = typeof input.cig === "string" ? input.cig : "…";
    return { running: `Scheda bando ${cig}`, done: `Scheda bando ${cig}` };
  }

  if (name === "reteEntita") {
    const n = Array.isArray(output.vicini) ? output.vicini.length : undefined;
    return { running: "Costruisco la rete", done: n ? `Rete — ${n} collegamenti` : "Rete" };
  }

  if (name === "stimaPrezzo") {
    const s = (output.stima ?? null) as { atteso?: number } | null;
    return {
      running: "Stimo il prezzo",
      done:
        s && typeof s.atteso === "number"
          ? `Stima: ~${new Intl.NumberFormat("it-IT").format(s.atteso)} €`
          : "Stima prezzo",
    };
  }

  if (name === "gareTema") {
    const t = typeof input.tema === "string" ? input.tema.slice(0, 30) : "";
    const tot = typeof output.totale === "number" ? output.totale : undefined;
    return {
      running: `Classifico tema «${t}»`,
      done: tot !== undefined ? `Tema «${t}» — ${tot} gare` : `Tema «${t}»`,
    };
  }

  if (name === "metriche") {
    const t = typeof input.titolo === "string" ? input.titolo : "metrica";
    return { running: `Calcolo «${t}»`, done: `Grafico: ${t}` };
  }

  if (name === "cercaWeb" || name.includes("web_search")) {
    return { running: "Cerco sul web", done: "Ricerca web" };
  }

  if (name === "queryGrafo") {
    const rows =
      typeof output.rowCount === "number" ? output.rowCount : undefined;
    const cypher = typeof input.cypher === "string" ? input.cypher : undefined;
    return {
      running: "Interrogo il grafo",
      done: rows !== undefined ? `Grafo interrogato — ${rows} righe` : "Grafo interrogato",
      detail: cypher,
    };
  }

  return { running: `Eseguo ${name}`, done: name };
}

export function ToolBlock({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const isError = part.state === "output-error" || (part.output as { ok?: boolean })?.ok === false;
  const isDone = part.state === "output-available" || part.state === "output-error";
  const dot = isError ? "err" : isDone ? "ok" : "run";
  const { running, done, detail } = describe(part);
  const label = isError ? "Errore" : isDone ? done : running;

  // Cosa mostrare espandendo: il cypher se c'è, altrimenti i parametri d'input.
  const hasInput = part.input && typeof part.input === "object" && Object.keys(part.input).length > 0;
  const expandable = detail ?? (hasInput ? JSON.stringify(part.input, null, 2) : undefined);
  // Messaggio d'errore (da state output-error o da output.ok===false).
  const errMsg =
    part.errorText ??
    ((part.output as { error?: string })?.error || (isError ? "il tool è fallito" : null));

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={`flex items-start font-serif text-sm ${
          isError ? "text-red-500" : "text-zinc-500"
        } ${expandable ? "hover:text-zinc-700" : "cursor-default"}`}
      >
        <Dot state={dot} />
        <span className="ml-2 text-left">
          {label}
          {!isDone && "…"}
        </span>
        {expandable && (
          <ChevronDown
            size={11}
            className={`relative top-[5px] ml-1 transition-transform duration-200 ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>

      {/* errore sempre visibile (qui capisci perché "si blocca") */}
      {isError && errMsg && (
        <span className="ml-[14px] mt-0.5 text-xs text-red-400">{errMsg}</span>
      )}

      {open && expandable && (
        <pre className="ml-[14px] mt-1 overflow-x-auto rounded-md bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-100">
          <code>{expandable}</code>
        </pre>
      )}
    </div>
  );
}
