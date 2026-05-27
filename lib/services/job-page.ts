import * as cheerio from "cheerio";

import { normalizeApplyUrl } from "@/lib/apply-url";
import { listingHtmlHeaders } from "@/lib/listing-html-headers";
import { extractCompensationRange } from "@/lib/services/job-enrichment";
import { inferCompanyNameFromListing, inferJobListingCoreFields } from "@/lib/services/llm";
import { isWorkAtAStartupListingUrl } from "@/lib/services/workatstartup";
import type { ParsedJobPage } from "@/lib/types";
import { slugify } from "@/lib/utils";

export { extractJobListingUrlsFromHtml } from "@/lib/services/job-listing-urls";

function pickContent($: cheerio.CheerioAPI, selectors: string[]) {
  for (const selector of selectors) {
    const value = $(selector).first().text().trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function textFromJsonLdCompany(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = textFromJsonLdCompany(item);
      if (value) {
        return value;
      }
    }
    return "";
  }

  const record = payload as Record<string, unknown>;
  const hiringOrganization = record.hiringOrganization;

  if (hiringOrganization && typeof hiringOrganization === "object" && !Array.isArray(hiringOrganization)) {
    const name = String((hiringOrganization as Record<string, unknown>).name ?? "").trim();
    if (name) {
      return name;
    }
  }

  const organization = record.organization;

  if (organization && typeof organization === "object" && !Array.isArray(organization)) {
    const name = String((organization as Record<string, unknown>).name ?? "").trim();
    if (name) {
      return name;
    }
  }

  if (String(record["@type"] ?? "").toLowerCase() === "organization") {
    const name = String(record.name ?? "").trim();
    if (name) {
      return name;
    }
  }

  for (const value of Object.values(record)) {
    const nested = textFromJsonLdCompany(value);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function textFromJsonLdJobTitle(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = textFromJsonLdJobTitle(item);
      if (value) {
        return value;
      }
    }
    return "";
  }

  const record = payload as Record<string, unknown>;
  const rawType = record["@type"];
  const typeLabels = Array.isArray(rawType)
    ? rawType.map((t) => String(t).toLowerCase())
    : [String(rawType ?? "").toLowerCase()];

  if (typeLabels.some((t) => t.includes("jobposting"))) {
    const jobTitle = String(record.title ?? "").trim();
    if (jobTitle) {
      return jobTitle;
    }
  }

  for (const value of Object.values(record)) {
    const nested = textFromJsonLdJobTitle(value);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function formatJobLocationValue(jl: unknown): string {
  if (!jl) {
    return "";
  }

  if (typeof jl === "string") {
    return jl.trim();
  }

  if (Array.isArray(jl)) {
    for (const item of jl) {
      const formatted = formatJobLocationValue(item);
      if (formatted) {
        return formatted;
      }
    }

    return "";
  }

  if (typeof jl === "object") {
    const o = jl as Record<string, unknown>;
    const name = String(o.name ?? "").trim();

    if (name) {
      return name;
    }

    const addr = o.address;

    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const locality = String(a.addressLocality ?? "").trim();
      const region = String(a.addressRegion ?? "").trim();
      const country = String(a.addressCountry ?? "").trim();
      const street = String(a.streetAddress ?? "").trim();
      const core = [locality, region].filter(Boolean).join(", ");

      if (street && core) {
        return `${street}, ${core}${country && country.length <= 3 ? `, ${country}` : ""}`.trim();
      }

      if (core) {
        return `${core}${country && country.length <= 3 ? `, ${country}` : ""}`.trim();
      }
    }
  }

  return "";
}

function textFromJsonLdJobLocation(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = textFromJsonLdJobLocation(item);
      if (value) {
        return value;
      }
    }

    return "";
  }

  const record = payload as Record<string, unknown>;
  const rawType = record["@type"];
  const typeLabels = Array.isArray(rawType)
    ? rawType.map((t) => String(t).toLowerCase())
    : [String(rawType ?? "").toLowerCase()];

  if (typeLabels.some((t) => t.includes("jobposting"))) {
    const formatted = formatJobLocationValue(record.jobLocation);
    if (formatted) {
      return formatted;
    }
  }

  for (const value of Object.values(record)) {
    const nested = textFromJsonLdJobLocation(value);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function normalizePostedAt(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function textFromJsonLdDatePosted(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = textFromJsonLdDatePosted(item);
      if (value) {
        return value;
      }
    }

    return "";
  }

  const record = payload as Record<string, unknown>;
  const rawType = record["@type"];
  const typeLabels = Array.isArray(rawType)
    ? rawType.map((t) => String(t).toLowerCase())
    : [String(rawType ?? "").toLowerCase()];

  if (typeLabels.some((t) => t.includes("jobposting"))) {
    const datePosted = String(record.datePosted ?? record.dateposted ?? "").trim();
    if (datePosted) {
      return datePosted;
    }
  }

  for (const value of Object.values(record)) {
    const nested = textFromJsonLdDatePosted(value);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function textFromJsonLdLogo(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = textFromJsonLdLogo(item);
      if (value) {
        return value;
      }
    }

    return "";
  }

  const record = payload as Record<string, unknown>;
  const rawType = record["@type"];
  const typeLabels = Array.isArray(rawType)
    ? rawType.map((t) => String(t).toLowerCase())
    : [String(rawType ?? "").toLowerCase()];

  if (typeLabels.some((t) => t.includes("jobposting"))) {
    const org = record.hiringOrganization;
    if (org && typeof org === "object" && !Array.isArray(org)) {
      const logo = (org as Record<string, unknown>).logo;
      if (typeof logo === "string" && logo.trim()) {
        return logo.trim();
      }
      if (logo && typeof logo === "object" && !Array.isArray(logo)) {
        const url = String((logo as Record<string, unknown>).url ?? "").trim();
        if (url) {
          return url;
        }
      }
    }
  }

  if (typeLabels.some((t) => t.includes("organization"))) {
    const logo = record.logo;
    if (typeof logo === "string" && logo.trim()) {
      return logo.trim();
    }
    if (logo && typeof logo === "object" && !Array.isArray(logo)) {
      const url = String((logo as Record<string, unknown>).url ?? "").trim();
      if (url) {
        return url;
      }
    }
  }

  for (const value of Object.values(record)) {
    const nested = textFromJsonLdLogo(value);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractCompanyLogoUrl($: cheerio.CheerioAPI, sourceUrl: string, jsonLdLogo: string): string | null {
  const candidates: string[] = [];

  if (jsonLdLogo.trim()) {
    candidates.push(jsonLdLogo.trim());
  }

  const ogImage = String($("meta[property='og:image']").attr("content") ?? "").trim();
  if (ogImage) {
    candidates.push(ogImage);
  }

  $("[data-testid='jobad-card-company-logo'], [data-testid='job-detail-company-logo'], img[class*='logo' i], img[alt*='logo' i]")
    .each((_, node) => {
      const src = String($(node).attr("src") ?? "").trim();
      if (src) {
        candidates.push(src);
      }
    });

  for (const candidate of candidates) {
    try {
      let absolute = new URL(candidate, sourceUrl).toString();
      if (!/^https?:\/\//i.test(absolute)) {
        continue;
      }
      try {
        const parsed = new URL(absolute);
        if (parsed.hostname === "next.jobteaser.com" || parsed.hostname.endsWith("jobteasercdn.com")) {
          const inner = parsed.searchParams.get("url");
          if (inner) {
            absolute = new URL(inner).toString();
          }
        }
      } catch {
      }
      if (absolute.startsWith("http://")) {
        absolute = `https://${absolute.slice(7)}`;
      }
      return absolute;
    } catch {
    }
  }

  return null;
}

function pickListingTitle(jsonLdTitle: string, domTitle: string, serpFallback: string): string {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  const fromLd = norm(jsonLdTitle);
  if (fromLd.length >= 2 && fromLd.length <= 240) {
    return fromLd;
  }
  const dom = norm(domTitle);
  const fb = norm(serpFallback);
  if (dom.length > 110 && fb.length >= 2 && fb.length < dom.length) {
    return fb;
  }
  if (dom.length >= 2) {
    return dom;
  }
  return fb;
}

function companyFromAtClause(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/\bat\s+([^()|,–—]+?)(?:\s*[|(]|,|\s+-\s+|$)/i);

  if (!match?.[1]) {
    return "";
  }

  return match[1]
    .trim()
    .replace(/\s+(remote|hybrid|on[\s-]?site)\s*$/i, "")
    .trim();
}

function inferCompanyFromTitle(title: string, locationHint = ""): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  const separators = [" - ", " | ", " @ ", " — ", " – ", " :: ", " : "];
  const hintNorm = locationHint.replace(/\s+/g, " ").trim().toLowerCase();

  function conflictsWithLocation(candidate: string): boolean {
    const chunk = candidate.trim().toLowerCase();
    if (!chunk) {
      return false;
    }

    if (!hintNorm) {
      return /^(remote|hybrid|anywhere|multiple locations)\b/i.test(chunk);
    }

    if (hintNorm.includes(chunk) || chunk.includes(hintNorm)) {
      return true;
    }

    if (/,\s*[a-z]{2}\b(?:\s*\d{5})?\s*$/i.test(candidate.trim())) {
      return true;
    }

    if (/^(remote|hybrid|anywhere|multiple locations)\b/i.test(chunk)) {
      return true;
    }

    return false;
  }

  for (const separator of separators) {
    const parts = normalized.split(separator).map((part) => part.trim()).filter(Boolean);

    if (parts.length > 1) {
      let candidate = parts[parts.length - 1];

      if (conflictsWithLocation(candidate)) {
        if (parts.length > 2) {
          candidate = parts[parts.length - 2];
        } else {
          continue;
        }
      }

      if (
        candidate &&
        !/^(job|careers?|apply|remote|hybrid|full time|part time)$/i.test(candidate) &&
        !conflictsWithLocation(candidate)
      ) {
        return candidate;
      }
    }
  }

  return "";
}

function prettifyCompanySlug(value: string) {
  const clean = value
    .replace(/^www\./i, "")
    .replace(/\.(com|io|co|ai|jobs)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    return "";
  }

  return clean
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractCompanyFromAtsUrl(urlString: string) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (host.endsWith("boards.greenhouse.io") && parts.length > 0) {
      return prettifyCompanySlug(parts[0]);
    }

    if (host === "jobs.lever.co" && parts.length > 0) {
      return prettifyCompanySlug(parts[0]);
    }
  } catch {
  }

  return "";
}

function extractCompanyFromText(listingText: string) {
  const text = listingText.replace(/\s+/g, " ").trim();

  const patterns = [
    /\bcompany\b\s*[:\-]\s*([A-Z][A-Za-z0-9&.,'()\/ -]{1,120})/i,
    /\bhiring organization\b\s*[:\-]\s*([A-Z][A-Za-z0-9&.,'()\/ -]{1,120})/i,
    /\babout\s+([A-Z][A-Za-z0-9&.,'()\/ -]{1,120})\b/,
    /\bjoin\s+([A-Z][A-Za-z0-9&.,'()\/ -]{1,120})\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] ?? "").trim();

    if (candidate && !/^(job|company|role|team|department|location)$/i.test(candidate)) {
      return candidate.replace(/\s{2,}/g, " ").trim();
    }
  }

  return "";
}

function normalizeCompanyName(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "";
  }

  if (/^unknown\b/i.test(clean)) {
    return "";
  }

  return clean;
}

function extractWorkAtAStartupListingText($: cheerio.CheerioAPI) {
  const sections = [
    $("div.my-3.rounded-md.border.border-gray-300.bg-beige-lighter.p-3").first().text(),
    $("main").text(),
    $("body").text()
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return Array.from(new Set(sections)).join("\n\n");
}

export async function parseJobHtml(
  html: string,
  sourceUrl: string,
  fallback: { title: string; company: string; location: string; snippet: string },
  options: {
    inferCompanyWithLlm?: boolean;
    geminiApiKey?: string | null;
    geminiModel?: string | null;
  } = {}
) {
  const inferCompanyWithLlm = options.inferCompanyWithLlm !== false;
  const $ = cheerio.load(html);
  const jsonLdScripts = $("script[type='application/ld+json']")
    .map((_, node) => $(node).contents().text().trim())
    .get()
    .filter(Boolean);

  let jsonLdCompany = "";
  let jsonLdJobTitle = "";
  let jsonLdLocation = "";
  let jsonLdDatePosted = "";
  let jsonLdLogo = "";

  for (const raw of jsonLdScripts) {
    try {
      const parsed = JSON.parse(raw) as unknown;

      if (!jsonLdCompany) {
        jsonLdCompany = textFromJsonLdCompany(parsed);
      }

      if (!jsonLdJobTitle) {
        jsonLdJobTitle = textFromJsonLdJobTitle(parsed);
      }

      if (!jsonLdLocation) {
        jsonLdLocation = textFromJsonLdJobLocation(parsed);
      }

      if (!jsonLdDatePosted) {
        jsonLdDatePosted = textFromJsonLdDatePosted(parsed);
      }

      if (!jsonLdLogo) {
        jsonLdLogo = textFromJsonLdLogo(parsed);
      }
    } catch {
    }

    if (jsonLdCompany && jsonLdJobTitle && jsonLdLocation && jsonLdDatePosted && jsonLdLogo) {
      break;
    }
  }

  const domTitleRaw =
    $("meta[property='og:title']").attr("content") ||
    pickContent($, ["h1", "[data-ui='job-title']", ".app-title"]) ||
    "";

  const listingText = isWorkAtAStartupListingUrl(sourceUrl)
    ? extractWorkAtAStartupListingText($)
    : $("main").text().replace(/\s+/g, " ").trim() || $("body").text().replace(/\s+/g, " ").trim();

  const structuredHints = [
    jsonLdJobTitle && `jobPostingTitle: ${jsonLdJobTitle}`,
    jsonLdCompany && `hiringOrganizationName: ${jsonLdCompany}`,
    jsonLdLocation && `jobPostingLocation: ${jsonLdLocation}`
  ]
    .filter(Boolean)
    .join("\n");

  let llmTitle = "";
  let llmCompany = "";
  let llmLocation = "";

  if (options.geminiApiKey?.trim()) {
    const core = await inferJobListingCoreFields(
      {
        sourceUrl,
        listingText,
        fallback,
        structuredHints: structuredHints.trim() ? structuredHints : undefined
      },
      { apiKey: options.geminiApiKey.trim(), model: options.geminiModel }
    );

    if (core) {
      llmTitle = core.title;
      llmCompany = core.company;
      llmLocation = core.location;
    }
  }

  const title = llmTitle.trim() || pickListingTitle(jsonLdJobTitle, domTitleRaw, fallback.title);

  const location =
    llmLocation.trim() ||
    (
      pickContent($, [".location", "[data-ui='location']", ".job-post__location"]) ||
      ""
    ).trim() ||
    jsonLdLocation.trim() ||
    fallback.location.trim();

  const summary = $("meta[name='description']").attr("content") || "";

  let company = normalizeCompanyName(llmCompany.trim());

  if (!company) {
    company = normalizeCompanyName(
      pickContent($, [
        ".company-name",
        "[data-ui='company-name']",
        ".job-post__company",
        "[data-testid='job-detail-company']",
        "[data-qa='company-name']",
        ".posting-categories .sort-by-time",
        ".posting-header__company",
        ".topcard__org-name-link",
        ".job-company",
        ".employer"
      ]) ||
        jsonLdCompany ||
        companyFromAtClause(title) ||
        $("meta[name='application-name']").attr("content") ||
        $("meta[property='og:site_name']").attr("content") ||
        extractCompanyFromText(listingText) ||
        inferCompanyFromTitle(title, location) ||
        extractCompanyFromAtsUrl(sourceUrl)
    );
  }

  const locNorm = location.replace(/\s+/g, " ").trim().toLowerCase();
  const compNorm = company.replace(/\s+/g, " ").trim().toLowerCase();

  if (company && locNorm && compNorm && compNorm === locNorm) {
    company = normalizeCompanyName(
      jsonLdCompany ||
        companyFromAtClause(title) ||
        extractCompanyFromAtsUrl(sourceUrl) ||
        extractCompanyFromText(listingText) ||
        inferCompanyFromTitle(title, location)
    );
  }

  if (!company && inferCompanyWithLlm) {
    company = normalizeCompanyName(
      await inferCompanyNameFromListing(
        {
          sourceUrl,
          title,
          listingText,
          hints: [
            extractCompanyFromAtsUrl(sourceUrl),
            inferCompanyFromTitle(title, location),
            $("meta[property='og:site_name']").attr("content") || ""
          ]
        },
        options.geminiApiKey?.trim()
          ? { apiKey: options.geminiApiKey.trim(), model: options.geminiModel ?? undefined }
          : undefined
      )
    );
  }

  if (!company) {
    company = extractCompanyFromAtsUrl(sourceUrl) || inferCompanyFromTitle(title, location) || "Company";
  }

  if (!title) {
    throw new Error(`Unable to determine job title from listing ${sourceUrl}`);
  }

  if (!location) {
    throw new Error(`Unable to determine job location from listing ${sourceUrl}`);
  }

  const links = $("a")
    .map((_, node) => {
      const href = $(node).attr("href");
      if (!href) {
        return null;
      }
      try {
        return new URL(href, sourceUrl).toString();
      } catch {
        return null;
      }
    })
    .get()
    .filter(Boolean);
  const applyUrl = isWorkAtAStartupListingUrl(sourceUrl)
    ? sourceUrl
    : $("a")
        .filter((_, node) => /apply|postuler|candidature/i.test($(node).text()))
        .first()
        .attr("href") || sourceUrl;

  const fields = $("form")
    .find("input, textarea, select")
    .map((_, node) => {
      const element = $(node);
      const id = element.attr("id");
      const label =
        (id ? $(`label[for='${id}']`).first().text().trim() : "") ||
        element.attr("name") ||
        element.attr("placeholder") ||
        "Field";
      const options =
        node.tagName === "select"
          ? element
              .find("option")
              .map((__, option) => $(option).text().trim())
              .get()
              .filter(Boolean)
          : [];

      const attrName = element.attr("name")?.trim();

      const key =
        attrName && attrName.length > 0
          ? attrName
          : slugify((element.attr("id") || label).trim() || "field");

      return {
        key,
        label,
        type: element.attr("type") || node.tagName,
        required: element.attr("required") !== undefined || /required/i.test(label),
        options
      };
    })
    .get();

  const resolvedApply = applyUrl.startsWith("http") ? applyUrl : new URL(applyUrl, sourceUrl).toString();
  const postedAt = normalizePostedAt(jsonLdDatePosted);
  const companyLogoUrl = extractCompanyLogoUrl($, sourceUrl, jsonLdLogo);

  return {
    title,
    company,
    location,
    summary,
    listingText,
    applyUrl: normalizeApplyUrl(resolvedApply),
    compensationRange: extractCompensationRange(listingText),
    companyHomepage:
      links.find((link) => /\/(?:company|about|home|careers?)\/?$/i.test(new URL(link).pathname)) ??
      links.find((link) => !/greenhouse|lever|workday|ashbyhq|linkedin|indeed|glassdoor|jobteaser|workatastartup/i.test(link)) ??
      null,
    companyLogoUrl,
    postedAt,
    linkedinLinks: [],
    hiringContacts: [],
    fields
  } satisfies ParsedJobPage;
}

export async function parseJobPage(sourceUrl: string, fallback: { title: string; company: string; location: string; snippet: string }) {
  const response = await fetch(sourceUrl, {
    headers: listingHtmlHeaders,
    signal: AbortSignal.timeout(90_000)
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch listing ${sourceUrl}: ${response.status}`);
  }

  const html = await response.text();
  return parseJobHtml(html, sourceUrl, fallback, { inferCompanyWithLlm: true });
}
