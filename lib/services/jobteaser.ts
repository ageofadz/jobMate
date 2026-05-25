export const JOBTEASER_BOARD_DOMAIN = "jobteaser.com";

type NominatimAddress = {
  country?: string;
  state?: string;
  region?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  city_district?: string;
  suburb?: string;
};

type NominatimPlace = {
  lat?: string;
  lon?: string;
  address?: NominatimAddress;
};

export type JobTeaserLocationMeta = {
  query: string;
  latitude: number;
  longitude: number;
  country: string;
  state: string;
  subState: string;
  city: string;
};

export type JobTeaserSearchSpec = {
  id: string;
  label: string;
  locationQuery: string;
  searchTerm: string;
  contract: "alternating" | null;
  url: string;
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedBoardDomain(domain: string) {
  return clean(domain).toLowerCase().replace(/^www\./i, "");
}

export function isJobTeaserBoardDomain(domain: string) {
  const normalized = normalizedBoardDomain(domain);
  return normalized === JOBTEASER_BOARD_DOMAIN || normalized.endsWith(`.${JOBTEASER_BOARD_DOMAIN}`);
}

export function hasJobTeaserBoard(boardDomains: string[]) {
  return boardDomains.some((domain) => isJobTeaserBoardDomain(domain));
}

function firstNonEmpty(parts: Array<string | undefined>) {
  for (const part of parts) {
    const value = clean(String(part ?? ""));
    if (value) {
      return value;
    }
  }

  return "";
}

function dedupeSequential(parts: string[]) {
  const out: string[] = [];

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if (out[out.length - 1] === part) {
      continue;
    }

    out.push(part);
  }

  return out;
}

export async function fetchJobTeaserLocationMeta(locationQuery: string): Promise<JobTeaserLocationMeta> {
  const trimmed = clean(locationQuery);

  if (!trimmed) {
    throw new Error("JobTeaser location cannot be empty.");
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "accept-language": "en",
      "user-agent": "JobMate/1.0"
    },
    signal: AbortSignal.timeout(90_000)
  });

  if (!response.ok) {
    throw new Error(`JobTeaser geocoding failed with ${response.status}.`);
  }

  const payload = (await response.json()) as NominatimPlace[];
  const place = payload[0];

  if (!place) {
    throw new Error(`JobTeaser geocoding returned no result for "${trimmed}".`);
  }

  const latitude = Number(place.lat ?? "");
  const longitude = Number(place.lon ?? "");

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`JobTeaser geocoding returned invalid coordinates for "${trimmed}".`);
  }

  const address = place.address ?? {};
  const country = firstNonEmpty([address.country]);
  const state = firstNonEmpty([address.state, address.region]);
  const subState = firstNonEmpty([address.county, address.city_district, address.suburb]);
  const city = firstNonEmpty([
    address.city,
    address.town,
    address.village,
    address.municipality,
    address.city_district,
    address.suburb,
    address.county
  ]);

  if (!country || !city) {
    throw new Error(`JobTeaser geocoding could not resolve a city/country for "${trimmed}".`);
  }

  return {
    query: trimmed,
    latitude,
    longitude,
    country,
    state,
    subState,
    city
  };
}

function buildJobTeaserLocationToken(meta: JobTeaserLocationMeta) {
  return dedupeSequential([meta.country, meta.state, meta.subState, meta.city]).join("::");
}

export function inferJobTeaserContract(title: string, keywordSeed: string[]) {
  const combined = clean([title, ...keywordSeed].join(" ")).toLowerCase();

  if (
    /\b(alternance|alternating|apprenticeship|apprentissage|apprenti|work[\s-]?study)\b/i.test(combined)
  ) {
    return "alternating" as const;
  }

  return null;
}

export function buildJobTeaserSearchSpec(input: {
  title: string;
  keywordSeed: string[];
  location: JobTeaserLocationMeta;
  radiusKm?: number;
}) {
  const searchTerm = clean(input.title);

  if (!searchTerm) {
    throw new Error("JobTeaser search term cannot be empty.");
  }

  const contract = inferJobTeaserContract(input.title, input.keywordSeed);
  const radiusKm = Math.max(1, Math.min(100, input.radiusKm ?? 30));
  const url = new URL("https://www.jobteaser.com/fr/job-offers");
  const locationToken = buildJobTeaserLocationToken(input.location);

  if (contract) {
    url.searchParams.set("contract", contract);
  }

  url.searchParams.set("lat", String(input.location.latitude));
  url.searchParams.set("lng", String(input.location.longitude));
  url.searchParams.append("localized_location", input.location.city);
  url.searchParams.append("localized_location", input.location.country);
  url.searchParams.set("location", locationToken);
  url.searchParams.set("q", searchTerm);
  url.searchParams.set("radius", String(radiusKm));
  url.searchParams.set("utm_source", "homepage");

  return {
    id: `${searchTerm.toLowerCase()}::${input.location.query.toLowerCase()}`,
    label: `${searchTerm} · ${input.location.query}`,
    locationQuery: input.location.query,
    searchTerm,
    contract,
    url: url.toString()
  } satisfies JobTeaserSearchSpec;
}
