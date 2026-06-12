import type { ActionFunctionArgs } from "react-router";

import { jobMatchesTargetLocations } from "../../../lib/services/llm";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: {
    geminiApiKey?: string;
    geminiModel?: string | null;
    jobLocation?: string;
    listingText?: string;
    targetLocations?: string[];
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";

  if (!geminiApiKey) {
    return Response.json({ error: "geminiApiKey is required" }, { status: 400 });
  }

  const targetLocations = Array.isArray(body.targetLocations)
    ? body.targetLocations.map((item) => String(item).trim()).filter(Boolean)
    : [];

  try {
    const matches = await jobMatchesTargetLocations({
      geminiApiKey,
      geminiModel: body.geminiModel ?? null,
      jobLocation: typeof body.jobLocation === "string" ? body.jobLocation : "",
      listingText: typeof body.listingText === "string" ? body.listingText : "",
      targetLocations
    });

    return Response.json({ matches });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
