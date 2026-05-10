import { getSerpApiKey } from "@/lib/settings-store";
import type { SearchCandidate } from "@/lib/types";

type SerpApiOrganicResult = {
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
  source?: string;
};

type SerpApiResponse = {
  organic_results?: SerpApiOrganicResult[];
};

export type OrganicSearchResult = {
  title: string;
  link: string;
  displayedLink: string;
  snippet: string;
};

function inferSiteSearchFromQuery(query: string) {
  const match = query.match(/\bsite:([^\s)"]+)/i);
  return match?.[1]?.trim() ?? null;
}

const BLOCKED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com"
];

function normalizeHost(host: string) {
  return host.replace(/^www\./i, "").toLowerCase();
}

function isAllowedBoardHost(host: string, boardDomains: string[]) {
  const normalized = normalizeHost(host);
  return boardDomains.some((domain) => {
    const target = normalizeHost(domain);
    if (target === "lever.co") {
      return normalized === "jobs.lever.co";
    }
    return normalized === target || normalized.endsWith(`.${target}`);
  });
}

function isValidJobListingUrl(urlString: string, boardDomains: string[]) {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  const host = normalizeHost(url.hostname);

  if (BLOCKED_HOSTS.includes(host)) {
    return false;
  }

  if (!isAllowedBoardHost(host, boardDomains)) {
    return false;
  }

  const path = url.pathname.toLowerCase();

  if (host.endsWith("boards.greenhouse.io")) {
    return /^\/[^/]+\/jobs\/\d+/.test(path) || /^\/embed\/job_app/.test(path);
  }

  if (host.endsWith("lever.co")) {
    return host === "jobs.lever.co" && /\/jobs\//.test(path);
  }

  return false;
}

function inferCompanyFromTitle(title: string) {
  const clean = title.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "";
  }

  const separators = [" - ", " | ", " @ ", " — ", " – ", " :: ", " : "];

  for (const separator of separators) {
    const parts = clean.split(separator).map((part) => part.trim()).filter(Boolean);

    if (parts.length > 1) {
      const candidate = parts[parts.length - 1];

      if (!/^(job|careers?|apply|remote|hybrid|full time|part time)$/i.test(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function inferCompanyFromHost(host: string) {
  const normalized = host.replace(/^www\./i, "").toLowerCase();
  const first = normalized.split(".")[0] ?? "";

  if (!first || /^(jobs?|careers?|boards?|apply|myworkdayjobs)$/i.test(first)) {
    return "";
  }

  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function searchGoogleOrganic(query: string, limit = 10) {
  const apiKey = getSerpApiKey();

  if (!apiKey) {
    return [] as OrganicSearchResult[];
  }

  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const collected: OrganicSearchResult[] = [];
  const pageSize = Math.min(10, cappedLimit);

  for (let start = 0; start < cappedLimit; start += pageSize) {
    const url = new URL("https://serpapi.com/search.json");
    const siteSearch = inferSiteSearchFromQuery(query);
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("num", String(Math.min(pageSize, cappedLimit - start)));
    url.searchParams.set("start", String(start));
    url.searchParams.set("nfpr", "1");
    url.searchParams.set("no_cache", "true");

    if (siteSearch) {
      url.searchParams.set("as_sitesearch", siteSearch);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`SERP API request failed with ${response.status}`);
    }

    const payload = (await response.json()) as SerpApiResponse;
    const pageResults = (payload.organic_results ?? [])
      .filter((result): result is SerpApiOrganicResult & { link: string } => Boolean(result.link))
      .map((result) => ({
        title: result.title ?? "Untitled",
        link: result.link,
        displayedLink: result.displayed_link ?? "",
        snippet: result.snippet ?? ""
      }));

    collected.push(...pageResults);

    if (pageResults.length < Math.min(pageSize, cappedLimit - start)) {
      break;
    }
  }

  return collected.slice(0, cappedLimit);
}

export async function searchGoogleListings(
  queries: string[],
  options: { limit?: number; boardDomains?: string[]; onQueryDone?: (query: string, count: number) => void } = {}
) {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const apiKey = getSerpApiKey();

  if (!apiKey) {
    return [] as SearchCandidate[];
  }

  const responses = await Promise.all(
    queries.map(async (query) => {
      const results = await searchGoogleOrganic(query, limit);
      options.onQueryDone?.(query, results.length);
      return {
        organic_results: results.map((result) => ({
          title: result.title,
          link: result.link,
          displayed_link: result.displayedLink,
          snippet: result.snippet
        }))
      } satisfies SerpApiResponse;
    })
  );

  const flattened = responses.flatMap((payload) => payload.organic_results ?? []);
  const deduped = new Map<string, SearchCandidate>();

  for (const result of flattened) {
    if (!result.link || deduped.has(result.link)) {
      continue;
    }

    const host = (() => {
      try {
        return new URL(result.link).hostname;
      } catch {
        return result.displayed_link ?? "unknown";
      }
    })();

    const companyFromTitle = inferCompanyFromTitle(result.title ?? "");
    const companyFromHost = inferCompanyFromHost(host);

    deduped.set(result.link, {
      sourceUrl: result.link,
      sourceTitle: result.title ?? "Untitled listing",
      sourceHost: host,
      company: companyFromTitle || companyFromHost,
      location: result.snippet?.match(/(?:Chicago|Remote|Hybrid|Austin|New York)/i)?.[0] ?? "Unknown",
      snippet: result.snippet ?? ""
    });
  }

  return [...deduped.values()].slice(0, limit);
}
