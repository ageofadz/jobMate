import type { ActionFunctionArgs } from "react-router";

import { fetchJobTeaserLocationMeta } from "@/lib/services/jobteaser";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { location?: string };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const location = typeof body.location === "string" ? body.location.trim() : "";

  if (!location) {
    return Response.json({ error: "location is required" }, { status: 400 });
  }

  try {
    const meta = await fetchJobTeaserLocationMeta(location);
    return Response.json(meta);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err)
      },
      { status: 422 }
    );
  }
}
