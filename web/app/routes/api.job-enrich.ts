import type { ActionFunctionArgs } from "react-router";

import { enrichJobLeadMetadata } from "../../../lib/services/job-enrichment";
import { generateJobDetailsSummary } from "../../../lib/services/llm";
import { searchGoogleOrganicWithApiKey } from "../../../lib/services/serp";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: {
    serpApiKey?: string;
    geminiApiKey?: string;
    geminiModel?: string | null;
    title?: string;
    company?: string;
    location?: string;
    listingText?: string;
    sourceUrl?: string;
    parsedHomepage?: string | null;
    parsedLinkedinLinks?: string[];
    parsedHiringContacts?: string[];
    parsedSummary?: string;
    parsedCompensationRange?: string | null;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const serpApiKey = typeof body.serpApiKey === "string" ? body.serpApiKey.trim() : "";

  const company = typeof body.company === "string" ? body.company : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const listingText = typeof body.listingText === "string" ? body.listingText : "";
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";

  if (!listingText.trim() || !sourceUrl) {
    return Response.json({ error: "listingText and sourceUrl are required" }, { status: 400 });
  }

  const parsedHomepage = typeof body.parsedHomepage === "string" ? body.parsedHomepage.trim() : body.parsedHomepage ?? null;
  const parsedLinkedinLinks = Array.isArray(body.parsedLinkedinLinks)
    ? body.parsedLinkedinLinks.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const parsedHiringContacts = Array.isArray(body.parsedHiringContacts)
    ? body.parsedHiringContacts.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const parsedSummary = typeof body.parsedSummary === "string" ? body.parsedSummary : "";
  const parsedCompensationRange =
    typeof body.parsedCompensationRange === "string" ? body.parsedCompensationRange.trim() : body.parsedCompensationRange ?? null;

  const fetchOrganic =
    serpApiKey.length > 0
      ? (query: string, limit: number) => searchGoogleOrganicWithApiKey(serpApiKey, query, limit)
      : (_query: string, _limit: number) => Promise.resolve([]);

  const leadMetadata = await enrichJobLeadMetadata({
    company,
    listingText,
    sourceUrl,
    parsedHomepage: parsedHomepage ?? null,
    parsedLinkedinLinks,
    fetchOrganic
  });

  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";
  const geminiModel = typeof body.geminiModel === "string" ? body.geminiModel.trim() : body.geminiModel ?? null;

  const summaryStored = await generateJobDetailsSummary(
    {
      title,
      company,
      location,
      listingText,
      fallbackSummary: parsedSummary
    },
    geminiApiKey ? { apiKey: geminiApiKey, model: geminiModel } : undefined
  );

  const linkedinLinks =
    leadMetadata.linkedinLinks.length > 0 ? leadMetadata.linkedinLinks : parsedLinkedinLinks;
  const hiringContacts =
    leadMetadata.hiringContacts.length > 0 ? leadMetadata.hiringContacts : parsedHiringContacts;

  return Response.json({
    compensationRange: leadMetadata.compensationRange ?? parsedCompensationRange ?? null,
    companyHomepage: leadMetadata.companyHomepage ?? (parsedHomepage?.trim() ? parsedHomepage : null),
    linkedinLinks,
    hiringContacts,
    summary: summaryStored
  });
}
