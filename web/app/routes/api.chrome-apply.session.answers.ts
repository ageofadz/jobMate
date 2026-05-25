import type { ActionFunctionArgs } from "react-router";

import { ensureChromeApplyCoverLetter } from "../../../lib/services/apply-cover-letter";
import { generateFormAnswers } from "../../../lib/services/llm";

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
    fields?: Array<{
      fieldId: string;
      key: string;
      label: string;
      type: string;
      required: boolean;
      options: string[];
    }>;
    pageLanguage?: string;
    retryNote?: string;
  };

  const fields = body.fields ?? [];
  const pageLanguage = typeof body.pageLanguage === "string" ? body.pageLanguage.trim().toLowerCase() : "";
  const retryNote = typeof body.retryNote === "string" ? body.retryNote.trim() : "";

  await ensureChromeApplyCoverLetter(session.payload, fields, {
    gemini: { apiKey: session.geminiApiKey, model: session.geminiModel },
    writeCoverTextFile: false,
    pageLanguage: pageLanguage || undefined
  });

  const resumePdf = session.payload.resumeUpload?.base64
    ? Buffer.from(session.payload.resumeUpload.base64, "base64")
    : null;

  const answersMap = await generateFormAnswers({
    contextBlock: session.payload.contextBlock,
    listingText: session.payload.listingText,
    fields,
    resumeText: resumePdf ? undefined : session.payload.resumeText,
    resumePdf,
    coverLetterText: session.payload.coverLetterText,
    writingSample: session.payload.writingSample,
    attemptNote: retryNote || undefined,
    gemini: { apiKey: session.geminiApiKey, model: session.geminiModel }
  });

  const resumeFieldIds: string[] = [];
  const answers = fields.map((field) => {
    const raw = answersMap.get(field.fieldId)?.answer ?? "";
    if (raw === "__resume__") {
      resumeFieldIds.push(field.fieldId);
      return { fieldId: field.fieldId, answer: "", reasoning: answersMap.get(field.fieldId)?.reasoning ?? "" };
    }
    return {
      fieldId: field.fieldId,
      answer: raw === "__cover_letter__" ? "" : raw,
      reasoning: answersMap.get(field.fieldId)?.reasoning ?? "No answer returned."
    };
  });

  return Response.json(
    {
      answers,
      resumeFieldIds,
      coverLetterText: session.payload.coverLetterText,
      coverUpload: session.payload.coverUpload
    },
    { headers: chromeApplyCorsHeaders }
  );
}
