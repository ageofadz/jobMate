import type { LoaderFunctionArgs } from "react-router";

import {
  chromeApplyCorsHeaders,
  getChromeApplySession,
  publicChromeApplyPayload
} from "../chrome-apply-sessions.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const id = params.sessionId;

  if (!id) {
    return Response.json({ error: "Missing session id" }, { status: 400, headers: chromeApplyCorsHeaders });
  }

  const session = getChromeApplySession(id);

  if (!session) {
    return Response.json({ error: "Unknown JobMate payload." }, { status: 404, headers: chromeApplyCorsHeaders });
  }

  return Response.json(publicChromeApplyPayload(session.payload), {
    headers: chromeApplyCorsHeaders
  });
}
