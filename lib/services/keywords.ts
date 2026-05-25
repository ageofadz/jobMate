import { uniq } from "@/lib/utils";
import type { PreferenceInput } from "@/lib/validators";
import { isJobTeaserBoardDomain } from "@/lib/services/jobteaser";

export function buildGeneratedKeywords(input: PreferenceInput) {
  const title = input.title.toLowerCase();
  const locationHints = input.locations.map((item) => item.toLowerCase());
  const boardHints = input.boardDomains.map((domain) => `site:${domain}`);
  const fragments = title.split(/\s+/).filter(Boolean);

  return uniq([
    input.title,
    ...input.keywordSeed,
    ...fragments,
    ...locationHints,
    ...boardHints
  ]).slice(0, 20);
}

function locationParenGroup(locations: string[]) {
  const inner = locations.map((loc) => `"${loc.trim()}"`).join(" OR ");
  return `(${inner})`;
}

function quotedKeywordBlob(terms: string[]) {
  return terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" ");
}

function leverJobsCombinedSearchQuery(terms: string[], locations: string[]) {
  const quoted = quotedKeywordBlob(terms);
  const trimLocs = locations.map((loc) => loc.trim()).filter(Boolean);
  const locPart =
    trimLocs.length === 1
      ? `"${trimLocs[0]}"`
      : trimLocs.length > 1
        ? `(${trimLocs.map((loc) => `"${loc}"`).join(" OR ")})`
        : "";

  return `site:jobs.lever.co ${quoted} ${locPart} "/apply"`.replace(/\s+/g, " ").trim();
}

export function buildSearchQueries(input: PreferenceInput) {
  const locationParen = locationParenGroup(input.locations);
  const roleTitle = input.title.trim();
  const expansionTerms = uniq(input.keywordSeed.map((s) => s.trim()).filter(Boolean)).filter(
    (term) => term !== roleTitle
  );
  const queries: string[] = [];
  const titleAndSeeds = [roleTitle, ...expansionTerms];
  const quotedTerms = quotedKeywordBlob(titleAndSeeds);

  for (const domain of input.boardDomains) {
    const normalizedDomain = domain.trim().toLowerCase();
    const isLeverBoard =
      normalizedDomain === "lever.co" || normalizedDomain === "jobs.lever.co";

    if (isJobTeaserBoardDomain(normalizedDomain)) {
      continue;
    }

    if (isLeverBoard) {
      queries.push(leverJobsCombinedSearchQuery(titleAndSeeds, input.locations).trim());
      continue;
    }

    const boardBase =
      normalizedDomain === "boards.greenhouse.io"
        ? `site:boards.greenhouse.io ${quotedTerms} ${locationParen}`
        : `site:${domain} ${quotedTerms} ${locationParen}`;

    queries.push(boardBase.trim());
  }

  return uniq(queries).slice(0, 12);
}

export function enrichPreferenceInput(input: PreferenceInput) {
  return {
    ...input,
    generatedKeywords: buildGeneratedKeywords(input),
    searchQueries: buildSearchQueries(input)
  };
}
