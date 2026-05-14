import type { ActionFunctionArgs } from "react-router";

function inferSiteSearchFromQuery(query: string) {
  const match = query.match(/\bsite:([^\s)"]+)/i);
  return match?.[1]?.trim() ?? null;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { apiKey?: string; query?: string; num?: number; start?: number };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const query = typeof body.query === "string" ? body.query : "";

  if (!apiKey || !query) {
    return Response.json({ error: "apiKey and query are required" }, { status: 400 });
  }

  const num = Math.max(1, Math.min(100, Number(body.num ?? 10)));
  const start = Math.max(0, Number(body.start ?? 0));

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(num));
  url.searchParams.set("start", String(start));
  url.searchParams.set("nfpr", "1");
  url.searchParams.set("no_cache", "true");

  const siteSearch = inferSiteSearchFromQuery(query);

  if (siteSearch && !/\bsite\s*:/i.test(query)) {
    url.searchParams.set("as_sitesearch", siteSearch);
  }

  const SERPAPI_REQUEST_MS = 90_000;
  let res: Response;

  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(SERPAPI_REQUEST_MS) });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const message =
      timedOut
        ? "SerpApi request timed out"
        : err instanceof Error
          ? err.message
          : "SerpApi request failed";
    return Response.json({ error: message }, { status: 504 });
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  const messageFromPayload =
    typeof payload.error === "string"
      ? payload.error
      : payload.error &&
          typeof payload.error === "object" &&
          payload.error !== null &&
          "message" in payload.error &&
          typeof (payload.error as { message?: unknown }).message === "string"
        ? (payload.error as { message: string }).message
        : "";

  if (!res.ok) {
    return Response.json(
      {
        error: messageFromPayload.trim() || `SerpApi HTTP ${res.status}`,
        status: res.status,
        payload
      },
      { status: 502 }
    );
  }

  if (messageFromPayload.trim()) {
    return Response.json({ error: messageFromPayload.trim(), payload }, { status: 502 });
  }

  return Response.json(payload);
}
