import type { ActionFunctionArgs } from "react-router";

import { chromeApplyCorsHeaders } from "../chrome-apply-sessions.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: chromeApplyCorsHeaders });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: chromeApplyCorsHeaders });
  }

  return Response.json({ ok: true }, { headers: chromeApplyCorsHeaders });
}
