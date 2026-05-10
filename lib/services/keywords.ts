import { uniq } from "@/lib/utils";
import type { PreferenceInput } from "@/lib/validators";

const SENIORITY_HINTS = ["staff engineer", "principal engineer", "senior staff engineer", "lead engineer"];

export function buildGeneratedKeywords(input: PreferenceInput) {
  const title = input.title.toLowerCase();
  const locationHints = input.locations.map((item) => item.toLowerCase());
  const boardHints = input.boardDomains.map((domain) => `site:${domain}`);
  const fragments = title.split(/\s+/).filter(Boolean);

  return uniq([
    input.title,
    ...input.keywordSeed,
    ...SENIORITY_HINTS.filter((hint) => title.includes("engineer") || title.includes("developer")),
    ...fragments,
    ...locationHints,
    ...boardHints
  ]).slice(0, 20);
}

export function buildSearchQueries(input: PreferenceInput) {
  const locationText = input.locations.map((location) => `"${location}"`).join(" OR ");
  const keywordTerms = uniq([input.title, ...input.keywordSeed]).filter(Boolean);
  const afterDate = new Date(Date.now() - Math.max(1, input.searchAfterDays) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const recency = `after:${afterDate}`;
  const queries: string[] = [];

  for (const domain of input.boardDomains) {
    const normalizedDomain = domain.trim().toLowerCase();
    const boardBase =
      normalizedDomain === "lever.co"
        ? `site:jobs.lever.co "${input.title}" (${locationText}) inurl:/jobs/ ${recency}`
        : normalizedDomain === "boards.greenhouse.io"
          ? `site:boards.greenhouse.io "${input.title}" (${locationText}) inurl:/jobs/ ${recency}`
          : `site:${domain} "${input.title}" (${locationText}) ${recency}`;

    queries.push(boardBase.trim());

    for (const keyword of keywordTerms) {
      const expanded =
        normalizedDomain === "lever.co"
          ? `site:jobs.lever.co "${keyword}" "${input.title}" (${locationText}) inurl:/jobs/ ${recency}`
          : normalizedDomain === "boards.greenhouse.io"
            ? `site:boards.greenhouse.io "${keyword}" "${input.title}" (${locationText}) inurl:/jobs/ ${recency}`
            : `site:${domain} "${keyword}" "${input.title}" (${locationText}) ${recency}`;

      queries.push(expanded.trim());
    }
  }

  return uniq(queries).slice(0, 12);
}
