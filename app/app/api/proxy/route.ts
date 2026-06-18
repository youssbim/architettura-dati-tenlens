// Proxy server-side per l'iframe: scarica la pagina e la riserve dalla NOSTRA
// origin senza header anti-embedding (X-Frame-Options/CSP), così i siti che
// bloccano l'iframe si vedono comunque. Inietta <base> per risolvere gli URL
// relativi verso il sito originale.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response("Missing ?url", { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return new Response("URL non valido", { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "it,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return new Response(
      `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:2rem;color:#555">Impossibile caricare la pagina.<br>${
        err instanceof Error ? err.message : ""
      }</body>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  // Header permissivi: niente X-Frame-Options / CSP che blocchino l'iframe.
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });

  // Contenuti non-HTML (pdf, immagini, ecc.): passali così come sono.
  if (!contentType.includes("text/html")) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  let html = await upstream.text();
  const baseHref = upstream.url || url.toString();

  // Inietta <base> per risolvere asset/link relativi verso il sito originale,
  // e rimuove eventuali <meta http-equiv="Content-Security-Policy">.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
  } else {
    html = `<base href="${baseHref}">` + html;
  }

  return new Response(html, { status: upstream.status, headers });
}
