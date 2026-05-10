import * as cheerio from "cheerio";

import { normalizeApplyUrl } from "@/lib/apply-url";
import { extractCompensationRange, extractEmails, extractLinkedinLinks } from "@/lib/services/job-enrichment";
import { inferCompanyNameFromListing } from "@/lib/services/llm";
import type { ParsedJobPage } from "@/lib/types";
import { slugify } from "@/lib/utils";

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

function inferCompanyFromTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const separators = [" - ", " | ", " @ ", " — ", " – ", " :: ", " : "];

  for (const separator of separators) {
    const parts = normalized.split(separator).map((part) => part.trim()).filter(Boolean);

    if (parts.length > 1) {
      const candidate = parts[parts.length - 1];
      if (candidate && !/^(job|careers?|apply|remote|hybrid)$/i.test(candidate)) {
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

export async function parseJobPage(sourceUrl: string, fallback: { title: string; company: string; location: string; snippet: string }) {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "JobMateBot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch listing ${sourceUrl}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const jsonLdCompany = $("script[type='application/ld+json']")
    .map((_, node) => {
      const raw = $(node).contents().text().trim();
      if (!raw) {
        return "";
      }
      try {
        return textFromJsonLdCompany(JSON.parse(raw));
      } catch {
        return "";
      }
    })
    .get()
    .find(Boolean) || "";

  const title =
    $("meta[property='og:title']").attr("content") ||
    pickContent($, ["h1", "[data-ui='job-title']", ".app-title"]);
  const location =
    pickContent($, [".location", "[data-ui='location']", ".job-post__location"]);
  const summary = $("meta[name='description']").attr("content") || "";

  const listingText = $("main").text().replace(/\s+/g, " ").trim() || $("body").text().replace(/\s+/g, " ").trim();
  let company = normalizeCompanyName(
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
    $("meta[name='application-name']").attr("content") ||
    $("meta[property='og:site_name']").attr("content") ||
    jsonLdCompany ||
    extractCompanyFromText(listingText) ||
    inferCompanyFromTitle(title) ||
    extractCompanyFromAtsUrl(sourceUrl)
  );

  if (!company) {
    company = normalizeCompanyName(
      await inferCompanyNameFromListing({
        sourceUrl,
        title,
        listingText,
        hints: [extractCompanyFromAtsUrl(sourceUrl), inferCompanyFromTitle(title), $("meta[property='og:site_name']").attr("content") || ""]
      })
    );
  }

  if (!company) {
    company = extractCompanyFromAtsUrl(sourceUrl) || inferCompanyFromTitle(title) || "Company";
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
  const applyUrl =
    $("a")
      .filter((_, node) => /apply/i.test($(node).text()))
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
      links.find((link) => !/greenhouse|lever|workday|ashbyhq|linkedin|indeed|glassdoor/i.test(link)) ??
      null,
    linkedinLinks: [...extractLinkedinLinks(html), ...links.filter((link) => /linkedin\.com/i.test(link))],
    hiringContacts: extractEmails(html),
    fields
  } satisfies ParsedJobPage;
}
