import { normalizeApplyUrl } from "@/lib/apply-url";
import type { SearchCandidate } from "@/lib/types";

type OrganicResultRow = {
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
};

type OrganicResultsBatch = {
  organic_results?: OrganicResultRow[];
};

export type OrganicSearchResult = {
  title: string;
  link: string;
  displayedLink: string;
  snippet: string;
};

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

function normalizeLeverOrganicLink(link: string): string {
  try {
    const host = new URL(link).hostname.toLowerCase();

    if (host.endsWith("lever.co")) {
      return normalizeApplyUrl(link);
    }
  } catch {
    return link;
  }

  return link;
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

function organicRowToCandidate(result: OrganicResultRow): SearchCandidate | null {
  if (!result.link) {
    return null;
  }

  const canonicalLink = normalizeLeverOrganicLink(result.link);

  const host = (() => {
    try {
      return new URL(canonicalLink).hostname;
    } catch {
      return result.displayed_link ?? "unknown";
    }
  })();

  const companyFromTitle = inferCompanyFromTitle(result.title ?? "");
  const companyFromHost = inferCompanyFromHost(host);

  return {
    sourceUrl: canonicalLink,
    sourceTitle: result.title ?? "Untitled listing",
    sourceHost: host,
    company: companyFromTitle || companyFromHost,
    location: result.snippet?.match(/(?:Chicago|Remote|Hybrid|Austin|New York)/i)?.[0] ?? "Unknown",
    snippet: result.snippet ?? ""
  };
}

export function mergeOrganicResultsToCandidates(
  organicRows: OrganicResultRow[],
  limit: number
): SearchCandidate[] {
  const deduped = new Map<string, SearchCandidate>();

  for (const result of organicRows) {
    if (!result.link) {
      continue;
    }

    const cand = organicRowToCandidate(result);

    if (!cand || deduped.has(cand.sourceUrl)) {
      continue;
    }

    deduped.set(cand.sourceUrl, cand);
  }

  return [...deduped.values()].slice(0, limit);
}

export function mergeOrganicResultsRoundRobin(
  perQueryRows: OrganicResultRow[][],
  limit: number
): SearchCandidate[] {
  const deduped = new Map<string, SearchCandidate>();
  let round = 0;

  while (deduped.size < limit) {
    let addedThisRound = false;

    for (const rows of perQueryRows) {
      if (deduped.size >= limit) {
        break;
      }

      const result = rows[round];

      if (!result?.link) {
        continue;
      }

      const cand = organicRowToCandidate(result);

      if (!cand || deduped.has(cand.sourceUrl)) {
        continue;
      }

      deduped.set(cand.sourceUrl, cand);
      addedThisRound = true;
    }

    if (!addedThisRound) {
      break;
    }

    round += 1;
  }

  return [...deduped.values()].slice(0, limit);
}

export type OrganicQueryProgressMeta = {
  completedQueries: number;
  totalQueries: number;
};

const ORGANIC_QUERY_DEADLINE_MS = 240_000;

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function searchGoogleListingsWithOrganicFetcher(
  queries: string[],
  fetchOrganic: (query: string, limit: number) => Promise<OrganicSearchResult[]>,
  options: {
    limit?: number;
    boardDomains?: string[];
    onQueryDone?: (query: string, count: number, meta: OrganicQueryProgressMeta) => void;
  } = {}
): Promise<SearchCandidate[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  let completedQueries = 0;
  const totalQueries = queries.length;

  const responses = await Promise.all(
    queries.map(async (query) => {
      let results: OrganicSearchResult[] = [];
      try {
        results = await raceWithTimeout(fetchOrganic(query, limit), ORGANIC_QUERY_DEADLINE_MS);
      } catch {
        results = [];
      }
      completedQueries += 1;
      options.onQueryDone?.(query, results.length, {
        completedQueries,
        totalQueries
      });
      return {
        organic_results: results.map((result) => ({
          title: result.title,
          link: result.link,
          displayed_link: result.displayedLink,
          snippet: result.snippet
        }))
      } satisfies OrganicResultsBatch;
    })
  );

  const perQuery = responses.map((payload) => payload.organic_results ?? []);
  return mergeOrganicResultsRoundRobin(perQuery, limit);
}
