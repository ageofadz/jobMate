import * as cheerio from "cheerio";

import { isWorkAtAStartupListingUrl } from "@/lib/services/workatstartup";

function normalizeListingUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

export function extractJobListingUrlsFromHtml(html: string, pageUrl: string) {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, node) => {
    const href = $(node).attr("href")?.trim();
    if (!href) {
      return;
    }

    try {
      const absolute = new URL(href, pageUrl).toString();
      const parsed = new URL(absolute);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const path = parsed.pathname;

      if (isWorkAtAStartupListingUrl(absolute)) {
        urls.add(normalizeListingUrl(absolute));
        return;
      }

      if (/greenhouse\.io$/i.test(host) && /\/jobs\/\d+/i.test(path)) {
        urls.add(normalizeListingUrl(absolute));
        return;
      }

      if (/lever\.co$/i.test(host) && /\/[^/]+\/[a-f0-9-]{10,}/i.test(path)) {
        urls.add(normalizeListingUrl(absolute));
        return;
      }

      if (/jobteaser\.com$/i.test(host) && /\/job-offers\/.+\d/i.test(path)) {
        urls.add(normalizeListingUrl(absolute));
      }
    } catch {
    }
  });

  return [...urls];
}
