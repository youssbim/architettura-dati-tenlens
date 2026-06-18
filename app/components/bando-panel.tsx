"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { FileText, X, Loader2, ExternalLink, FileSignature, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWeb } from "@/components/web-panel";

// ---------------------------------------------------------------------------
// Contesto: chiunque può aprire il pannello con un CIG.
// ---------------------------------------------------------------------------
type BandoCtx = { open: (cig: string) => void };
const Ctx = createContext<BandoCtx | null>(null);

export function useBando() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useBando deve stare dentro <BandoProvider>");
  return c;
}

// ---------------------------------------------------------------------------
// Chip cliccabile: il "pulsante" che cita un bando.
// ---------------------------------------------------------------------------
export function BandoChip({ cig, oggetto }: { cig: string; oggetto?: string }) {
  const { open } = useBando();
  return (
    <button
      type="button"
      onClick={() => open(cig)}
      className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-xs text-zinc-700 shadow-sm transition-all hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <span className="font-mono text-[11px] text-zinc-500">{cig}</span>
      {oggetto && (
        <span className="truncate text-zinc-700 dark:text-zinc-300">— {oggetto}</span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Provider + drawer laterale.
// ---------------------------------------------------------------------------
type Bando = Record<string, unknown> & {
  cig?: string;
  oggetto?: string | null;
  natura?: string | null;
  importoBase?: number | null;
  procedura?: string | null;
  cpv?: unknown;
  luogo?: Record<string, unknown> | null;
  dataPubblicazione?: string | null;
  dataScadenza?: string | null;
  stazioneAppaltante?: Record<string, unknown> | null;
  aggiudicazioni?: Record<string, unknown>[];
  avvisi?: Record<string, unknown>[];
  rettifiche?: Record<string, unknown>[];
  link?: { piattaforma?: string | null; ted?: string | null } | null;
};

const eur = (v: unknown) =>
  typeof v === "number"
    ? new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(v)
    : "—";

const str = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export function BandoProvider({ children }: { children: React.ReactNode }) {
  const { open: openWeb } = useWeb();
  const [cig, setCig] = useState<string | null>(null);
  const [bando, setBando] = useState<Bando | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((c: string) => setCig(c), []);
  const close = useCallback(() => setCig(null), []);

  useEffect(() => {
    if (!cig) return;
    setLoading(true);
    setError(null);
    setBando(null);
    fetch(`/api/bando/${encodeURIComponent(cig)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `Errore ${r.status}`);
        return r.json();
      })
      .then(setBando)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [cig]);

  // Chiudi con Esc.
  useEffect(() => {
    if (!cig) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cig, close]);

  const sa = bando?.stazioneAppaltante ?? null;
  const luogo = bando?.luogo ?? null;

  // Stato derivato: l'87% dei bandi non ha dataScadenza (gare già concluse).
  const scad = typeof bando?.dataScadenza === "string" ? bando.dataScadenza : null;
  const aggiudicato = (bando?.aggiudicazioni?.length ?? 0) > 0;
  const today = new Date().toISOString().slice(0, 10);
  // Preferisci lo stato calcolato dal server; fallback al calcolo locale.
  const statoSrv = typeof bando?.stato === "string" ? bando.stato : null;
  const statoKey =
    statoSrv ??
    (aggiudicato ? "aggiudicato" : scad && scad >= today ? "aperto" : scad ? "scaduto" : "concluso/non datato");
  const STATI: Record<string, { label: string; cls: string }> = {
    aggiudicato: { label: "Aggiudicato", cls: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" },
    aperto: { label: "Aperto", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
    scaduto: { label: "Scaduto", cls: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300" },
    "concluso/non datato": { label: "Concluso / non datato", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  };
  const stato = STATI[statoKey] ?? STATI["concluso/non datato"];

  return (
    <Ctx.Provider value={{ open }}>
      {children}

      {/* overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity",
          cig ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={close}
      />

      {/* drawer */}
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950",
          cig ? "translate-x-0" : "translate-x-full"
        )}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Scheda bando
            </span>
            {cig && (
              <span className="font-mono text-xs text-zinc-400">{cig}</span>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Carico la scheda…
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}

          {bando && (
            <div className="flex flex-col gap-5">
              <div>
                <h2 className="text-base font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
                  {str(bando.oggetto)}
                </h2>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", stato.cls)}>
                    {stato.label}
                  </span>
                  {bando.natura && <Tag>{String(bando.natura)}</Tag>}
                  {bando.procedura && <Tag>{String(bando.procedura)}</Tag>}
                </div>
              </div>

              {(bando.link?.piattaforma || bando.link?.ted) && (
                <div className="flex flex-wrap gap-2">
                  {bando.link?.piattaforma && (
                    <button
                      type="button"
                      onClick={() => openWeb(bando.link!.piattaforma!)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                    >
                      <FileSignature className="h-3.5 w-3.5" />
                      Consulta / Partecipa
                    </button>
                  )}
                  {bando.link?.ted && (
                    <button
                      type="button"
                      onClick={() => openWeb(bando.link!.ted!)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <Landmark className="h-3.5 w-3.5" />
                      Avviso TED
                    </button>
                  )}
                </div>
              )}

              <Grid>
                <Field label="Importo base" value={eur(bando.importoBase)} />
                <Field
                  label="Luogo"
                  value={str(luogo?.istat ?? luogo?.nuts ?? null)}
                />
                <Field label="Pubblicazione" value={str(bando.dataPubblicazione)} />
                <Field
                  label="Scadenza"
                  value={scad ?? "non indicata"}
                />
              </Grid>

              <Section title="Stazione appaltante">
                <p className="text-sm text-zinc-800 dark:text-zinc-200">
                  {str(sa?.denominazione)}
                </p>
                {sa?.cf != null && (
                  <p className="font-mono text-xs text-zinc-400">CF {String(sa.cf)}</p>
                )}
              </Section>

              <Section title={`Aggiudicatari (${bando.aggiudicazioni?.length ?? 0})`}>
                {bando.aggiudicazioni && bando.aggiudicazioni.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {bando.aggiudicazioni.map((a, i) => {
                      const imp = a.impresa as Record<string, unknown> | undefined;
                      return (
                        <li
                          key={i}
                          className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                        >
                          <p className="text-sm text-zinc-800 dark:text-zinc-200">
                            {str(imp?.denominazione)}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {imp?.cf ? `CF ${String(imp.cf)} · ` : ""}
                            {eur(a.importo)}
                            {a.esito ? ` · ${String(a.esito)}` : ""}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-400">Nessuna aggiudicazione registrata.</p>
                )}
              </Section>

              <Section
                title={`Avvisi e rettifiche (${
                  (bando.avvisi?.length ?? 0) + (bando.rettifiche?.length ?? 0)
                })`}
              >
                {bando.avvisi && bando.avvisi.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {bando.avvisi.map((av, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            av.tipo === "rettifica" ? "bg-amber-400" : "bg-emerald-400"
                          )}
                        />
                        <span className="text-zinc-700 dark:text-zinc-300">
                          {str(av.tipo)}
                        </span>
                        <span className="text-zinc-400">{str(av.data)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-400">Nessun avviso.</p>
                )}
              </Section>
            </div>
          )}
        </div>
      </aside>
    </Ctx.Provider>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </span>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-3">{children}</div>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
        {title}
      </p>
      {children}
    </div>
  );
}
