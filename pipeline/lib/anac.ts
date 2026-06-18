const BASE = "https://pubblicitalegale.anticorruzione.it/api/v0";

const HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://pubblicitalegale.anticorruzione.it",
  Referer: "https://pubblicitalegale.anticorruzione.it/",
};

export type AvvisoListItem = {
  idAvviso: string;
  idAppalto: string;
  codiceScheda: string;
  codiceEform: string | null;
  dataScadenza: string | null;
  dataPubblicazione: string;
  dataPubblicazioneRettifica: string | null;
  dataCreazione: string;
  tipo: "avviso" | "rettifica" | string;
  attivo: boolean;
  oscurato: boolean;
  nuovoAvviso: string | null;
  template?: unknown[];
};

export type AvvisoDetail = AvvisoListItem & {
  _id?: { timestamp: number; date: string };
  dataPCP?: string;
  template: Array<{
    codiceScheda?: string;
    dataPubblicazione?: string;
    template?: {
      metadata?: {
        titolo?: string | null;
        descrizione?: string | null;
        link_eform_ted?: string | null;
      };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }>;
};

export type Page<T> = {
  content: T[];
  pageable: { pageNumber: number; pageSize: number };
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
  first: boolean;
  last: boolean;
  numberOfElements: number;
  empty: boolean;
};

async function get<T>(path: string, revalidate = 60): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: HEADERS,
    next: { revalidate },
  });
  if (!res.ok) {
    throw new Error(`ANAC ${res.status} ${res.statusText} :: ${path}`);
  }
  return (await res.json()) as T;
}

export function getAvvisi(opts: { page?: number; size?: number } = {}) {
  const page = opts.page ?? 0;
  const size = opts.size ?? 20;
  return get<Page<AvvisoListItem>>(`/avvisi?page=${page}&size=${size}`, 30);
}

// Variante keyset: filtra per finestra di pubblicazione (DD/MM/yyyy) e ordina
// stabilmente → ogni richiesta resta "poco profonda" (niente offset su tutti i 2,3M).
// Con timeout esplicito per non restare appesi ai 504/180s del gateway.
export async function getAvvisiWindow(opts: {
  page: number;
  size: number;
  start: string; // DD/MM/yyyy
  end: string; // DD/MM/yyyy
  timeoutMs?: number;
}): Promise<Page<AvvisoListItem>> {
  const qs = new URLSearchParams({
    page: String(opts.page),
    size: String(opts.size),
    dataPubblicazioneStart: opts.start,
    dataPubblicazioneEnd: opts.end,
    sortField: "dataPubblicazione",
    sortDirection: "ASC",
    ricercaArchivio: "true",
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120000);
  try {
    const res = await fetch(`${BASE}/avvisi?${qs}`, {
      headers: HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ANAC ${res.status} ${res.statusText}`);
    return (await res.json()) as Page<AvvisoListItem>;
  } finally {
    clearTimeout(t);
  }
}

export function getAvviso(id: string) {
  return get<AvvisoDetail>(`/avvisi/${encodeURIComponent(id)}`, 300);
}

export function getCronologia(id: string, idAppalto?: string) {
  const qs = new URLSearchParams({ ricercaArchivio: "false" });
  if (idAppalto) qs.set("idAppalto", idAppalto);
  return get<AvvisoListItem[]>(
    `/avvisi/${encodeURIComponent(id)}/cronologia?${qs}`,
    300,
  );
}

export type CursorPage<T> = {
  content: T[];
  count: number;
  firstPaginationToken: string | null;
  lastPaginationToken: string | null;
};

export function searchAvvisi(opts: {
  q: string;
  size?: number;
  paginationToken?: string;
}) {
  const size = opts.size ?? 20;
  const qs = new URLSearchParams({ fullText: opts.q, size: String(size) });
  if (opts.paginationToken) qs.set("paginationToken", opts.paginationToken);
  return get<CursorPage<AvvisoListItem>>(`/avvisi-full-text?${qs}`, 60);
}

export function getRecentDates() {
  return get<string[]>(`/date`, 600);
}

export type SchedaMap = {
  templateSchedeMapping: Array<{ template: string; codiceScheda: string[] }>;
};

export function getSchedaMap() {
  return get<SchedaMap>(`/map`, 86400);
}

export { HEADERS as ANAC_HEADERS, BASE as ANAC_BASE };
