import type { ActionFunctionArgs } from "react-router";

import type { ChromeApplyPayload } from "../../../lib/chrome-extension/payload-server";

import { putChromeApplySession } from "../chrome-apply-sessions.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = (await request.json()) as {
    geminiApiKey?: string;
    geminiModel?: string;
    payload?: ChromeApplyPayload;
  };

  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";
  const geminiModel =
    typeof body.geminiModel === "string" && body.geminiModel.trim()
      ? body.geminiModel.trim()
      : "gemini-3.1-flash-lite";
  const payload = body.payload;

  if (!geminiApiKey || !payload?.id) {
    return Response.json({ error: "geminiApiKey and payload.id are required" }, { status: 400 });
  }

  putChromeApplySession(payload.id, {
    payload,
    geminiApiKey,
    geminiModel
  });

  const origin = new URL(request.url).origin;
  const base = `${origin}/api/chrome-apply/${payload.id}`;

  return Response.json({
    payloadUrl: `${base}/payload`,
    answersUrl: `${base}/answers`,
    completeUrl: `${base}/complete`
  });
}
