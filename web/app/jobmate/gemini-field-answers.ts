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
const GEMINI_STABLE_FALLBACK_MODEL = "gemini-2.5-flash";

const COMPENSATION_INSTRUCTIONS = [
  "For desired salary, compensation expectation, salary range, pay, rate, or minimum compensation fields, analyze the listing's posted compensation and the candidate's preferred compensation range from the candidate context.",
  "If the listing includes compensation, answer with a concise value or range inside the overlap between the posted range and the candidate's preferred range.",
  "If there is overlap and the candidate is a strong fit, lean toward the upper half of that overlap.",
  "If the listing does not include compensation, answer from the candidate's preferred compensation range.",
  "Do not leave required compensation fields empty when the candidate context contains a preferred compensation range."
];

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
      ? "Use only the provided candidate context and the attached resume PDF file."
      : "Use only the provided candidate context.",
    "Read each field label carefully and answer that exact question.",
    "Never answer a different question than the field asks.",
    "Be concise, concrete, and truthful.",
    "Use normal capitalization. Do not return answers in all caps unless the field explicitly requires an acronym or code.",
    "For optional demographic, equal opportunity, race, ethnicity, gender, pronoun, disability, or veteran self-identification fields, return an empty answer so the app can skip them.",
    "For required demographic/self-identification choice fields, choose the available option equivalent to 'I do not wish to answer', 'Decline to self-identify', 'Prefer not to say', or 'I don't want to answer'.",
    "For source/referral fields like 'How did you hear about this job?', answer exactly 'Google'.",
    "For yes/no fields, answer exactly 'Yes' or 'No'.",
    "For multi-select fields, return a comma-separated list of selected option labels.",
    ...COMPENSATION_INSTRUCTIONS,
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
  const primary = params.geminiModel.trim() || "gemini-3-flash-preview";
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
