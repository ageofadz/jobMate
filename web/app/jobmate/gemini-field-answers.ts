type FieldDef = { key: string; label: string; type: string; required: boolean; options: string[] };

export type FieldAnswer = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  answer: string;
  reasoning: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type GeminiUserPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

const GEMINI_FALLBACK_MODEL = "gemini-2-flash";
const GEMINI_STABLE_FALLBACK_MODEL = "gemini-3.1-flash-lite";

function parseJsonObject(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error("Empty LLM output.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }

    throw new Error("LLM output did not contain a JSON object.");
  }
}

function buildFallbackAnswers(fieldLabels: string[], contextBlock: string) {
  return fieldLabels.map<FieldAnswer>((label, index) => ({
    key: `field-${index + 1}`,
    label,
    type: "text",
    required: true,
    options: [],
    answer: contextBlock.slice(0, 240),
    reasoning: "Fallback answer generated without an LLM provider."
  }));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

async function callGeminiParts(apiKey: string, model: string, parts: GeminiUserPart[], json: boolean) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: json
          ? {
            responseMimeType: "application/json"
          }
          : undefined
      })
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${model}: ${response.status}${text ? ` ${text.slice(0, 500)}` : ""}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text =
    payload.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("") ?? "";

  if (!text.trim()) {
    throw new Error(`${model}: empty response`);
  }

  return text;
}

export type EmailJobStatus = "rejected" | "waiting" | "needs_action" | null;

export async function classifyJobEmailStatus(params: {
  geminiApiKey: string | null;
  geminiModel: string;
  jobs: { id: string; company: string; sourceTitle: string; appliedAt: string }[];
  inboxText: string;
}): Promise<{ jobId: string; emailStatus: EmailJobStatus; evidence: string }[]> {
  if (!params.geminiApiKey?.trim() || !params.jobs.length || !params.inboxText.trim()) {
    return params.jobs.map((j) => ({ jobId: j.id, emailStatus: null, evidence: "" }));
  }

  const prompt = [
    "You are checking an email inbox for job application status updates.",
    "For each applied job below, determine if the inbox contains a meaningful status email.",
    "IGNORE acknowledgment emails like 'We received your application', 'Thank you for applying', 'Application submitted' — these are expected and carry no status.",
    "Look for: rejection emails, interview invitations, requests for more info, or other recruiter follow-ups.",
    "If there is no meaningful status email for a job, return null for that job.",
    `Status values: "rejected" (rejected/not selected), "waiting" (interview scheduled or awaiting response), "needs_action" (requires candidate action like completing a task or responding).`,
    `Return valid JSON only with shape: {"updates":[{"jobId":"","emailStatus":"rejected"|"waiting"|"needs_action"|null,"evidence":"one sentence"}]}`,
    `Applied jobs: ${JSON.stringify(params.jobs.map((j) => ({ id: j.id, company: j.company, title: j.sourceTitle, appliedAt: j.appliedAt })))}`,
    `Inbox text (may be truncated): ${params.inboxText.slice(0, 12000)}`
  ].join("\n\n");

  const apiKey = params.geminiApiKey.trim();
  const primary = params.geminiModel.trim() || "gemini-3.1-flash-lite";
  const models = Array.from(new Set([primary, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  for (const model of models) {
    try {
      const text = await callGeminiParts(apiKey, model, [{ text: prompt }], true);
      const parsed = parseJsonObject(text) as {
        updates?: Array<{ jobId: string; emailStatus: EmailJobStatus; evidence: string }>;
      };

      if (Array.isArray(parsed.updates)) {
        return params.jobs.map((j) => {
          const match = parsed.updates!.find((u) => u.jobId === j.id);
          return { jobId: j.id, emailStatus: match?.emailStatus ?? null, evidence: match?.evidence ?? "" };
        });
      }
    } catch {
    }
  }

  return params.jobs.map((j) => ({ jobId: j.id, emailStatus: null, evidence: "" }));
}

export async function generateFieldAnswersWithGemini(params: {
  geminiApiKey: string | null;
  geminiModel: string;
  contextBlock: string;
  listingText: string;
  fields: FieldDef[];
  resumePdfBytes?: Uint8Array | null;
}): Promise<FieldAnswer[]> {
  const fields = params.fields;

  if (!fields.length) {
    return [];
  }

  if (!params.geminiApiKey?.trim()) {
    return fields.map((field) => ({
      ...buildFallbackAnswers([field.label], params.contextBlock)[0],
      key: field.key,
      type: field.type,
      required: field.required,
      options: field.options,
      reasoning: `Fallback answer for ${field.label}.`
    }));
  }

  const hasPdf = Boolean(params.resumePdfBytes && params.resumePdfBytes.byteLength > 0);
  const prompt = [
    "You are generating direct job application form answers.",
    hasPdf
      ? "Use the provided candidate context and attached resume PDF."
      : "Use the provided candidate context.",
    "Return exactly one answer per field key in Fields JSON.",
    "Read each field label, type, and options literally.",
    "Required fields must be non-empty.",
    "For select, radio, and checkbox fields, return the exact text of one listed option.",
    "Return valid JSON only with shape {\"answers\":[{\"key\":\"\",\"label\":\"\",\"answer\":\"\",\"reasoning\":\"\"}]}.",
    `Candidate context: ${params.contextBlock}`,
    `Job listing text: ${params.listingText.slice(0, 8000)}`,
    `Fields: ${JSON.stringify(fields)}`
  ].join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdfBytes) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: uint8ToBase64(params.resumePdfBytes)
      }
    });
  }

  const apiKey = params.geminiApiKey.trim();
  const primary = params.geminiModel.trim() || "gemini-3.1-flash-lite";
  const models = Array.from(new Set([primary, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));
  let lastError = "";

  for (const model of models) {
    try {
      const text = await callGeminiParts(apiKey, model, parts, true);
      const parsed = parseJsonObject(text) as {
        answers?: Array<{ key: string; label: string; answer: string; reasoning: string }>;
      };

      return fields.map((field) => {
        const match = parsed.answers?.find((answer) => answer.key === field.key || answer.label === field.label);

        return {
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          options: field.options,
          answer: match?.answer ?? "",
          reasoning: match?.reasoning ?? "No rationale returned."
        };
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    answer: "",
    reasoning: lastError || "Gemini request failed."
  }));
}
