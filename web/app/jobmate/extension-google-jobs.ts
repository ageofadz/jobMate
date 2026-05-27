import * as cheerio from "cheerio";

import type { SearchCandidate } from "../../../lib/types";

import { fetchPageHtmlViaExtension } from "./extension-page-html";

const AGGREGATOR_DOMAINS = [
  "indeed.com",
  "linkedin.com",
  "glassdoor.com",
  "monster.com",
  "ziprecruiter.com",
  "careerbuilder.com",
  "dice.com",
  "simplyhired.com",
  "snagajob.com",
  "getwork.com",
  "themuse.com",
  "wellfound.com",
  "otta.com",
  "jobs.google.com"
];

function isAggregatorUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isGoogleUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return host === "google.com" || host.endsWith(".google.com");
  } catch {
    return false;
  }
}

type JobPostingRaw = Record<string, unknown>;

function extractJobPostings(data: unknown): JobPostingRaw[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  if (Array.isArray(data)) {
    return (data as unknown[]).flatMap(extractJobPostings);
  }

  const d = data as Record<string, unknown>;
  const type = String(d["@type"] ?? "");

  if (type === "JobPosting") {
    return [d];
  }

  if (type === "ItemList" && Array.isArray(d.itemListElement)) {
    return (d.itemListElement as unknown[]).flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const inner = (item as Record<string, unknown>).item ?? item;
      return extractJobPostings(inner);
    });
  }

  return [];
}

function jobPostingLocation(posting: JobPostingRaw): string {
  const loc = posting.jobLocation;
  if (!loc) {
    return "Unknown";
  }
  const entry = Array.isArray(loc) ? (loc as unknown[])[0] : loc;
  if (!entry || typeof entry !== "object") {
    return "Unknown";
  }
  const addr = (entry as Record<string, unknown>).address;
  if (!addr || typeof addr !== "object") {
    return "Unknown";
  }
  const a = addr as Record<string, unknown>;
  const parts = [String(a.addressLocality ?? ""), String(a.addressRegion ?? "")].filter(Boolean);
  return parts.join(", ") || "Unknown";
}

function parseFromJsonLd(html: string): SearchCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).html() ?? "";
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      return;
    }

    for (const posting of extractJobPostings(data)) {
      const rawUrl = String(posting.url ?? "").trim();
      if (!rawUrl || isGoogleUrl(rawUrl) || isAggregatorUrl(rawUrl)) {
        continue;
      }

      let canonical: string;
      try {
        canonical = new URL(rawUrl).href;
      } catch {
        continue;
      }

      if (seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);

      const host = new URL(canonical).hostname;
      const company = String(
        (posting.hiringOrganization as Record<string, unknown> | undefined)?.name ?? ""
      ).trim();

      candidates.push({
        sourceUrl: canonical,
        sourceTitle: String(posting.title ?? "Untitled listing").trim(),
        sourceHost: host,
        company,
        location: jobPostingLocation(posting),
        snippet: String(posting.description ?? "").slice(0, 200)
      });
    }
  });

  return candidates;
}

function parseFromAtsLinks(html: string, pageUrl: string): SearchCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, node) => {
    const href = $(node).attr("href")?.trim();
    if (!href) {
      return;
    }

    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    if (isAggregatorUrl(absolute) || isGoogleUrl(absolute)) {
      return;
    }

    const host = new URL(absolute).hostname.replace(/^www\./i, "").toLowerCase();
    const path = new URL(absolute).pathname;

    const isKnownAts =
      (/greenhouse\.io$/i.test(host) && /\/jobs\/\d+/i.test(path)) ||
      (/lever\.co$/i.test(host) && /\/[^/]+\/[a-f0-9-]{10,}/i.test(path)) ||
      /myworkdayjobs\.com$/i.test(host) ||
      (/smartrecruiters\.com$/i.test(host) && /\/[^/]+\/jobs\//i.test(path)) ||
      /ashbyhq\.com$/i.test(host) ||
      (/breezy\.hr$/i.test(host) && /\/p\//i.test(path)) ||
      (/taleo\.net$/i.test(host) && /\/careersection\//i.test(path)) ||
      (/icims\.com$/i.test(host) && /\/jobs\//i.test(path)) ||
      (/jobteaser\.com$/i.test(host) && /\/job-offers\//i.test(path));

    if (!isKnownAts) {
      return;
    }

    if (seen.has(absolute)) {
      return;
    }
    seen.add(absolute);

    const label = $(node).text().replace(/\s+/g, " ").trim() || "Untitled listing";

    candidates.push({
      sourceUrl: absolute,
      sourceTitle: label,
      sourceHost: new URL(absolute).hostname,
      company: "",
      location: "Unknown",
      snippet: ""
    });
  });

  return candidates;
}

export function parseGoogleJobsCandidatesFromHtml(html: string, pageUrl: string): SearchCandidate[] {
  const fromLd = parseFromJsonLd(html);
  if (fromLd.length > 0) {
    return fromLd;
  }
  return parseFromAtsLinks(html, pageUrl);
}

export async function fetchGoogleJobsCandidatesViaExtension(
  url: string,
  limit: number
): Promise<SearchCandidate[]> {
  const fetched = await fetchPageHtmlViaExtension(url);
  if (!fetched.ok || !fetched.html.trim()) {
    return [];
  }
  const candidates = parseGoogleJobsCandidatesFromHtml(fetched.html, fetched.finalUrl || url);
  return candidates.slice(0, limit);
}
