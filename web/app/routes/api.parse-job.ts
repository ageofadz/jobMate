import type { ActionFunctionArgs } from "react-router";

import { parseJobHtml } from "../../../lib/services/job-page";

type Fallback = { title: string; company: string; location: string; snippet: string };

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: {
    html?: string;
    sourceUrl?: string;
    fallback?: Fallback;
    geminiApiKey?: string;
    geminiModel?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const html = typeof body.html === "string" ? body.html : "";
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  const fallback = body.fallback;
  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";

  if (!html || !sourceUrl || !fallback) {
    return Response.json({ error: "html, sourceUrl, and fallback are required" }, { status: 400 });
  }

  try {
    const parsed = await parseJobHtml(html, sourceUrl, fallback, {
      inferCompanyWithLlm: true,
      geminiApiKey: geminiApiKey || null,
      geminiModel: typeof body.geminiModel === "string" ? body.geminiModel.trim() : null
    });
    return Response.json(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 422 });
  }
}
