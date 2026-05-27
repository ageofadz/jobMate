import type { LoaderFunctionArgs } from "react-router";

import { isAllowedCompanyLogoUrl, resolveCompanyLogoFetchUrl } from "../jobmate/company-logo-url";

export async function loader({ request }: LoaderFunctionArgs) {
  const raw = new URL(request.url).searchParams.get("url");
  const fetchUrl = resolveCompanyLogoFetchUrl(raw);
  if (!fetchUrl || !isAllowedCompanyLogoUrl(fetchUrl)) {
    return new Response(null, { status: 400 });
  }

  const upstream = await fetch(fetchUrl);
  if (!upstream.ok) {
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400"
    }
  });
}
