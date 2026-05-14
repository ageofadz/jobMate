import { getSerpApiKey } from "@/lib/settings-store";
import type { SearchCandidate } from "@/lib/types";

import {
  searchGoogleListingsWithOrganicFetcher,
  type OrganicSearchResult,
  type OrganicQueryProgressMeta
} from "@/lib/services/serp-shared";

export type { OrganicSearchResult, OrganicQueryProgressMeta };
export {
  mergeOrganicResultsToCandidates,
  mergeOrganicResultsRoundRobin,
  searchGoogleListingsWithOrganicFetcher
} from "@/lib/services/serp-shared";

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

function inferSiteSearchFromQuery(query: string) {
  const match = query.match(/\bsite:([^\s)"]+)/i);
  return match?.[1]?.trim() ?? null;
}

export async function searchGoogleOrganicWithApiKey(apiKey: string, query: string, limit = 10) {
  const trimmed = apiKey.trim();

  if (!trimmed || !query.trim()) {
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
    url.searchParams.set("api_key", trimmed);
    url.searchParams.set("num", String(Math.min(pageSize, cappedLimit - start)));
    url.searchParams.set("start", String(start));
    url.searchParams.set("nfpr", "1");
    url.searchParams.set("no_cache", "true");

    if (siteSearch && !/\bsite\s*:/i.test(query)) {
      url.searchParams.set("as_sitesearch", siteSearch);
    }

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(90_000) });

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

export async function searchGoogleOrganic(query: string, limit = 10) {
  const apiKey = getSerpApiKey();

  if (!apiKey) {
    return [] as OrganicSearchResult[];
  }

  return searchGoogleOrganicWithApiKey(apiKey, query, limit);
}

export async function searchGoogleListings(
  queries: string[],
  options: {
    limit?: number;
    boardDomains?: string[];
    onQueryDone?: (query: string, count: number, meta: OrganicQueryProgressMeta) => void;
  } = {}
): Promise<SearchCandidate[]> {
  const apiKey = getSerpApiKey();

  if (!apiKey) {
    return [] as SearchCandidate[];
  }

  return searchGoogleListingsWithOrganicFetcher(queries, (q, lim) => searchGoogleOrganic(q, lim), options);
}
