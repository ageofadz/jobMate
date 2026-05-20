import type { ActionFunctionArgs } from "react-router";

import { listingHtmlHeaders } from "@/lib/listing-html-headers";

function isAllowedListingUrl(urlString: string) {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return false;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();

  return (
    host.endsWith("boards.greenhouse.io") ||
    host.endsWith("greenhouse.io") ||
    host === "jobs.lever.co" ||
    host.endsWith(".lever.co")
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { url?: string };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";

  if (!url || !isAllowedListingUrl(url)) {
    return Response.json({ error: "URL not allowed" }, { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: listingHtmlHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(90_000)
    });

    const html = await res.text();

    return Response.json({
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      html
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return Response.json(
      {
        ok: false,
        status: 0,
        finalUrl: url,
        html: "",
        error: `upstream: ${message}`
      },
      { status: 502 }
    );
  }
}
