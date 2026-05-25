import type { ActionFunctionArgs } from "react-router";

import { nextBrowserAction, type PageElement } from "../../../lib/services/llm";

import { chromeApplyCorsHeaders, getChromeApplySession } from "../chrome-apply-sessions.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: chromeApplyCorsHeaders });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: chromeApplyCorsHeaders });
  }

  const id = params.sessionId;
  const session = id ? getChromeApplySession(id) : undefined;

  if (!session) {
    return Response.json({ error: "Unknown JobMate payload." }, { status: 404, headers: chromeApplyCorsHeaders });
  }

  const body = (await request.json()) as {
    pageUrl?: string;
    pageText?: string;
    stepIndex?: number;
    history?: Array<{
      step: number;
      tool: string;
      reasoning?: string;
      elementId?: string | null;
      url?: string | null;
    }>;
    hiddenApplyUrl?: string | null;
    elements?: PageElement[];
  };

  const browserAction = await nextBrowserAction({
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
    pageText: typeof body.pageText === "string" ? body.pageText : "",
    stepIndex: typeof body.stepIndex === "number" ? body.stepIndex : 0,
    history: Array.isArray(body.history) ? body.history : [],
    targetApplyUrl: session.payload.applyUrl,
    targetTitle: session.payload.title,
    targetCompany: session.payload.company,
    candidateEmail: session.payload.candidateEmail,
    hiddenApplyUrl: typeof body.hiddenApplyUrl === "string" ? body.hiddenApplyUrl : null,
    listingText: session.payload.listingText,
    elements: Array.isArray(body.elements) ? body.elements : [],
    gemini: { apiKey: session.geminiApiKey, model: session.geminiModel }
  });

  return Response.json(browserAction, { headers: chromeApplyCorsHeaders });
}
