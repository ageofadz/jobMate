import type { ActionFunctionArgs } from "react-router";

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
  };

  const fields = body.fields ?? [];

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
    gemini: { apiKey: session.geminiApiKey, model: session.geminiModel }
  });

  const answers = fields.map((field) => ({
    fieldId: field.fieldId,
    answer: answersMap.get(field.fieldId)?.answer ?? "",
    reasoning: answersMap.get(field.fieldId)?.reasoning ?? "No answer returned."
  }));

  return Response.json(
    {
      answers,
      coverLetterText: session.payload.coverLetterText,
      coverUpload: session.payload.coverUpload
    },
    { headers: chromeApplyCorsHeaders }
  );
}
