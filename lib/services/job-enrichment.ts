import type { OrganicSearchResult } from "@/lib/services/organic-search";
import { listingHtmlHeaders } from "@/lib/listing-html-headers";

const ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "workdayjobs.com",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "jobvite.com",
  "icims.com",
  "linkedin.com",
  "indeed.com",
  "glassdoor.com"
];

function uniq(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

const IMAGE_FILE_TLD = /^(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

function dropImageArtifactEmails(emails: string[]) {
  return emails.filter((email) => {
    const lower = email.toLowerCase();
    const domain = lower.split("@")[1] ?? "";
    const host = domain.split(":")[0];
    const lastDot = host.lastIndexOf(".");

    if (lastDot < 0) {
      return true;
    }

    const tld = host.slice(lastDot + 1);
    return !IMAGE_FILE_TLD.test(tld);
  });
}

export function extractEmails(text: string) {
  return dropImageArtifactEmails(
    uniq(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
  );
}

export function extractLinkedinLinks(text: string) {
  return uniq(text.match(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/[^\s"'<>),]+/gi) ?? []).slice(0, 20);
}

export function extractCompensationRange(text: string) {
  const clean = text.replace(/\s+/g, " ");
  const patterns = [
    /\$ ?\d{2,3}(?:,\d{3})?(?:\.\d+)? ?(?:k|K)?\s*(?:-|to|–|—)\s*\$? ?\d{2,3}(?:,\d{3})?(?:\.\d+)? ?(?:k|K)?(?:\s*(?:\/|per)\s*(?:year|yr|hour|hr))?/,
    /\b(?:salary|compensation|pay range)[:\s]+.{0,80}?\$ ?\d{2,3}(?:,\d{3})?.{0,40}?\$ ?\d{2,3}(?:,\d{3})?/i
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[0]) {
      return match[0].trim();
    }
  }

  return null;
}

function isLikelyCompanyHomepage(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return !ATS_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return false;
  }
}

async function extractCompanyPageSignals(url: string) {
  try {
    const response = await fetch(url, {
      headers: listingHtmlHeaders,
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      return { emails: [] as string[], linkedinLinks: [] as string[] };
    }

    const html = await response.text();
    return {
      emails: extractEmails(html),
      linkedinLinks: extractLinkedinLinks(html)
    };
  } catch {
    return { emails: [] as string[], linkedinLinks: [] as string[] };
  }
}

function emailsCompatibleWithCompany(emails: string[], company: string): string[] {
  const govEmployer =
    /\b(city|county|state|federal|government|municipal|district)\b/i.test(company) || /\.gov\b/i.test(company);

  return emails.filter((email) => {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";

    if (!domain) {
      return false;
    }

    if ((domain.endsWith(".gov") || domain.endsWith(".mil")) && !govEmployer) {
      return false;
    }

    return true;
  });
}

export async function enrichJobLeadMetadata(params: {
  company: string;
  listingText: string;
  sourceUrl: string;
  parsedHomepage?: string | null;
  parsedLinkedinLinks?: string[];
  fetchOrganic?: (query: string, limit: number) => Promise<OrganicSearchResult[]>;
}) {
  const fetchOrganic = params.fetchOrganic;
  const emails = extractEmails(params.listingText);
  const linkedinLinks = [...(params.parsedLinkedinLinks ?? []), ...extractLinkedinLinks(params.listingText)];
  let companyHomepage = params.parsedHomepage && isLikelyCompanyHomepage(params.parsedHomepage) ? params.parsedHomepage : null;

  if (fetchOrganic && params.company.trim()) {
    const searches = await Promise.allSettled([
      fetchOrganic(`${params.company} official website`, 5),
      fetchOrganic(`${params.company} recruiter hiring manager LinkedIn`, 10),
      fetchOrganic(`${params.company} careers contact email`, 10)
    ]);

    for (const settled of searches) {
      if (settled.status !== "fulfilled") {
        continue;
      }

      for (const result of settled.value) {
        if (!companyHomepage && isLikelyCompanyHomepage(result.link)) {
          companyHomepage = result.link;
        }

        if (/linkedin\.com\/(?:in|company)\//i.test(result.link)) {
          linkedinLinks.push(result.link);
        }

        emails.push(...extractEmails(`${result.title} ${result.snippet}`));
      }
    }
  }

  if (companyHomepage) {
    const pageSignals = await extractCompanyPageSignals(companyHomepage);
    emails.push(...pageSignals.emails);
    linkedinLinks.push(...pageSignals.linkedinLinks);
  }

  const mergedEmails = uniq(emails);
  const filteredEmails = emailsCompatibleWithCompany(mergedEmails, params.company);

  return {
    compensationRange: extractCompensationRange(params.listingText),
    companyHomepage,
    linkedinLinks: uniq(linkedinLinks).slice(0, 20),
    hiringContacts: filteredEmails.slice(0, 20)
  };
}
