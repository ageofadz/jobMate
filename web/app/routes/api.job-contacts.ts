import type { ActionFunctionArgs } from "react-router";

import { enrichJobLeadMetadata } from "../../../lib/services/job-enrichment";
import { searchGoogleOrganicWithApiKey } from "../../../lib/services/serp";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: {
    serpApiKey?: string;
    company?: string;
    listingText?: string;
    sourceUrl?: string;
    parsedHomepage?: string | null;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const serpApiKey = typeof body.serpApiKey === "string" ? body.serpApiKey.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const listingText = typeof body.listingText === "string" ? body.listingText : "";
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  const parsedHomepage = typeof body.parsedHomepage === "string" ? body.parsedHomepage.trim() : body.parsedHomepage ?? null;

  if (!listingText.trim() || !sourceUrl) {
    return Response.json({ error: "listingText and sourceUrl are required" }, { status: 400 });
  }

  const fetchOrganic =
    serpApiKey.length > 0
      ? (query: string, limit: number) => searchGoogleOrganicWithApiKey(serpApiKey, query, limit)
      : (_query: string, _limit: number) => Promise.resolve([]);

  const leadMetadata = await enrichJobLeadMetadata({
    company,
    listingText,
    sourceUrl,
    parsedHomepage: parsedHomepage ?? null,
    parsedLinkedinLinks: [],
    fetchOrganic
  });

  return Response.json({
    linkedinLinks: leadMetadata.linkedinLinks,
    hiringContacts: leadMetadata.hiringContacts,
    companyHomepage: leadMetadata.companyHomepage ?? (parsedHomepage?.trim() ? parsedHomepage : null)
  });
}
