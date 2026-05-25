export const WORK_AT_A_STARTUP_BOARD_DOMAIN = "workatastartup.com";

export type WorkAtAStartupSearchSpec = {
  id: string;
  label: string;
  locationQuery: string;
  role: string;
  jobType: "fulltime" | "internship";
  url: string;
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedBoardDomain(domain: string) {
  return clean(domain).toLowerCase().replace(/^www\./i, "");
}

export function isWorkAtAStartupBoardDomain(domain: string) {
  const normalized = normalizedBoardDomain(domain);
  return normalized === WORK_AT_A_STARTUP_BOARD_DOMAIN || normalized.endsWith(`.${WORK_AT_A_STARTUP_BOARD_DOMAIN}`);
}

export function hasWorkAtAStartupBoard(boardDomains: string[]) {
  return boardDomains.some((domain) => isWorkAtAStartupBoardDomain(domain));
}

export function isWorkAtAStartupListingUrl(urlString: string) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    return (
      (host === WORK_AT_A_STARTUP_BOARD_DOMAIN || host.endsWith(`.${WORK_AT_A_STARTUP_BOARD_DOMAIN}`)) &&
      /^\/jobs\/\d+\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function inferWorkAtAStartupRole(title: string, keywordSeed: string[]) {
  const combined = clean([title, ...keywordSeed].join(" ")).toLowerCase();

  if (
    /\b(engineer|engineering|developer|frontend|front[- ]end|backend|back[- ]end|full[- ]stack|devops|sre|platform|mobile|ios|android|qa|software|data engineer|machine learning|ml)\b/i.test(
      combined
    )
  ) {
    return "eng";
  }

  if (/\b(design|designer|ux|ui|product design|visual design|brand design|research)\b/i.test(combined)) {
    return "design";
  }

  if (/\b(product manager|product management|product\b|program manager|project manager)\b/i.test(combined)) {
    return "product";
  }

  if (/\b(marketing|growth|demand gen|content|seo|brand marketing)\b/i.test(combined)) {
    return "marketing";
  }

  if (/\b(account executive|sales|business development|account manager|partnerships|revenue)\b/i.test(combined)) {
    return "sales";
  }

  if (/\b(customer success|customer support|support engineer|technical support)\b/i.test(combined)) {
    return "support";
  }

  if (/\b(recruiter|recruiting|talent|people ops|people operations|human resources|hr)\b/i.test(combined)) {
    return "people";
  }

  if (/\b(operations|bizops|business operations|strategy|founder associate|chief of staff)\b/i.test(combined)) {
    return "operations";
  }

  return "any";
}

function inferWorkAtAStartupJobType(title: string, keywordSeed: string[]) {
  const combined = clean([title, ...keywordSeed].join(" ")).toLowerCase();
  return /\b(intern|internship)\b/i.test(combined) ? "internship" : "fulltime";
}

function normalizeLocationQuery(locationQuery: string) {
  const trimmed = clean(locationQuery);

  if (!trimmed) {
    throw new Error("Work at a Startup location cannot be empty.");
  }

  if (/,\s*[A-Z]{2},\s*US$/i.test(trimmed) || /,\s*[A-Z][A-Za-z .'-]{2,}$/.test(trimmed)) {
    return trimmed;
  }

  if (/,\s*[A-Z]{2}$/i.test(trimmed)) {
    return `${trimmed}, US`;
  }

  return trimmed;
}

export function buildWorkAtAStartupSearchSpec(input: {
  title: string;
  keywordSeed: string[];
  locationQuery: string;
}) {
  const locationQuery = normalizeLocationQuery(input.locationQuery);
  const role = inferWorkAtAStartupRole(input.title, input.keywordSeed);
  const jobType = inferWorkAtAStartupJobType(input.title, input.keywordSeed);
  const url = new URL("https://www.workatastartup.com/companies");

  url.searchParams.set("demographic", "any");
  url.searchParams.set("hasEquity", "any");
  url.searchParams.set("hasSalary", "any");
  url.searchParams.set("industry", "any");
  url.searchParams.set("interviewProcess", "any");
  url.searchParams.set("jobType", jobType);
  url.searchParams.set("layout", "list-compact");
  url.searchParams.set("locations", locationQuery);
  url.searchParams.set("role", role);
  url.searchParams.set("sortBy", "created_desc");
  url.searchParams.set("tab", "any");
  url.searchParams.set("usVisaNotRequired", "any");

  return {
    id: `${clean(input.title).toLowerCase()}::${locationQuery.toLowerCase()}`,
    label: `${clean(input.title)} · ${locationQuery}`,
    locationQuery,
    role,
    jobType,
    url: url.toString()
  } satisfies WorkAtAStartupSearchSpec;
}
