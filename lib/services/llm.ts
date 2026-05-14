import type { FieldAnswer } from "@/lib/types";

import { translate, type AppLanguage } from "@/lib/i18n";
import { getGeminiApiKey, getGeminiModel } from "@/lib/settings-store";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

const GEMINI_PRIMARY_MODEL = "gemini-3-flash-preview";
const GEMINI_FALLBACK_MODEL = "gemini-2-flash";
const GEMINI_STABLE_FALLBACK_MODEL = "gemini-2.5-flash";

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

function normalizeGeneratedPlainText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/[•]/g, "-")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "")
    .trim();
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

function getGeminiModels() {
  const primary = getGeminiModel() || GEMINI_PRIMARY_MODEL;
  return Array.from(new Set([primary, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));
}

type GeminiUserPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

async function callGeminiGenerateWithKey(
  parts: GeminiUserPart[],
  apiKey: string,
  models: string[],
  options: { json?: boolean } = {}
): Promise<string> {
  let lastError = "";

  for (const model of models) {
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
          generationConfig: options.json
            ? {
                responseMimeType: "application/json"
              }
            : undefined
        })
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      lastError = `${model}: ${response.status}${text ? ` ${text.slice(0, 500)}` : ""}`;
      continue;
    }

    const payload = (await response.json()) as GeminiResponse;
    const text =
      payload.candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("") ?? "";

    if (text.trim()) {
      return text;
    }

    lastError = `${model}: empty response`;
  }

  throw new Error(`Gemini request failed. ${lastError}`);
}

async function callGeminiGenerate(parts: GeminiUserPart[], options: { json?: boolean } = {}) {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    throw new Error("No Gemini API key configured.");
  }

  return callGeminiGenerateWithKey(parts, apiKey, getGeminiModels(), options);
}

async function callGeminiText(prompt: string, options: { json?: boolean } = {}) {
  return callGeminiGenerate([{ text: prompt }], options);
}

function hasGeminiKey() {
  return Boolean(getGeminiApiKey());
}

const COMPENSATION_INSTRUCTIONS = [
  "For desired salary, compensation expectation, salary range, pay, rate, or minimum compensation fields, analyze the listing's posted compensation and the candidate's preferred compensation range from the candidate context.",
  "If the listing includes compensation, answer with a concise value or range inside the overlap between the posted range and the candidate's preferred range.",
  "If there is overlap and the candidate is a strong fit, lean toward the upper half of that overlap.",
  "If the listing does not include compensation, answer from the candidate's preferred compensation range.",
  "Do not leave required compensation fields empty when the candidate context contains a preferred compensation range."
];

export async function generateFieldAnswers(params: {
  contextBlock: string;
  listingText: string;
  fields: Array<{ key: string; label: string; type: string; required: boolean; options: string[] }>;
  resumeText?: string;
  resumePdf?: Buffer | null;
}) {
  if (!params.fields.length) {
    return [] as FieldAnswer[];
  }

  if (!hasGeminiKey()) {
    return params.fields.map((field) => ({
      ...buildFallbackAnswers([field.label], params.contextBlock)[0],
      key: field.key,
      type: field.type,
      required: field.required,
      options: field.options,
      reasoning: `Fallback answer for ${field.label}.`
    }));
  }

  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);
  const prompt = [
    "You are generating direct job application form answers.",
    hasPdf
      ? "Use only the provided candidate context and the attached resume PDF file."
      : "Use only the provided candidate context and resume text.",
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
    !hasPdf && params.resumeText ? `Resume text: ${params.resumeText}` : "",
    `Job listing text: ${params.listingText.slice(0, 8000)}`,
    `Fields: ${JSON.stringify(params.fields)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdf) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: params.resumePdf.toString("base64")
      }
    });
  }

  try {
    const text = await callGeminiGenerate(parts, { json: true });
    const parsed = parseJsonObject(text) as {
      answers?: Array<{ key: string; label: string; answer: string; reasoning: string }>;
    };

    return params.fields.map((field) => {
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
  } catch (err) {
    return params.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
      answer: "",
      reasoning: err instanceof Error ? err.message : "Gemini returned unusable output."
    }));
  }
}

export async function generateFieldAnswer(params: {
  contextBlock: string;
  listingText: string;
  field: { key: string; label: string; type: string; required: boolean; options: string[] };
  resumeText?: string;
  resumePdf?: Buffer | null;
}) {
  const fallback = buildFallbackAnswers([params.field.label], params.contextBlock)[0];

  if (!hasGeminiKey()) {
    return {
      ...fallback,
      key: params.field.key,
      type: params.field.type,
      required: params.field.required,
      options: params.field.options,
      reasoning: `Fallback answer for ${params.field.label}.`
    };
  }

  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);
  const prompt = [
    "You are answering exactly one job application form field.",
    "Your first priority is the literal field label. Do not answer any other question.",
    "If the field asks for city/state/location, return only the location value, e.g. 'Chicago, IL'.",
    "If the field asks how the candidate heard about the job, return exactly 'Google'.",
    "If the field asks for a URL, return only a URL.",
    "If the field asks for a phone number, return only a phone number if present in the candidate context; otherwise return an empty string.",
    "If the field asks for optional demographic, equal opportunity, race, ethnicity, gender, pronoun, disability, or veteran self-identification, return an empty string.",
    "If the field is a required demographic/self-identification choice field, choose the available option equivalent to 'I do not wish to answer', 'Decline to self-identify', 'Prefer not to say', or 'I don't want to answer'.",
    "For yes/no fields, answer exactly 'Yes' or 'No'.",
    "For select, radio, or checkbox fields, answer using the closest available option label from the provided options. If no option fits, return an empty string.",
    ...COMPENSATION_INSTRUCTIONS,
    hasPdf
      ? "Use only the candidate context and the attached resume PDF file. Be concise, concrete, and truthful."
      : "Use only the candidate context and resume text. Be concise, concrete, and truthful.",
    "Return valid JSON only: {\"key\":\"\",\"label\":\"\",\"answer\":\"\",\"reasoning\":\"\"}.",
    `Field key: ${params.field.key}`,
    `Field label: ${params.field.label}`,
    `Field type: ${params.field.type}`,
    `Field required: ${params.field.required}`,
    `Available options: ${JSON.stringify(params.field.options)}`,
    `Candidate context:\n${params.contextBlock}`,
    !hasPdf && params.resumeText ? `Resume text:\n${params.resumeText}` : "",
    `Job listing text:\n${params.listingText.slice(0, 8000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdf) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: params.resumePdf.toString("base64")
      }
    });
  }

  try {
    const text = await callGeminiGenerate(parts, { json: true });
    const parsed = parseJsonObject(text) as { key?: string; label?: string; answer?: string; reasoning?: string };

    return {
      key: params.field.key,
      label: params.field.label,
      type: params.field.type,
      required: params.field.required,
      options: params.field.options,
      answer: String(parsed.answer ?? ""),
      reasoning: parsed.reasoning ?? "Answered as an isolated field."
    };
  } catch (err) {
    return {
      key: params.field.key,
      label: params.field.label,
      type: params.field.type,
      required: params.field.required,
      options: params.field.options,
      answer: "",
      reasoning: err instanceof Error ? err.message : "Gemini returned unusable output."
    };
  }
}

export async function generateJobDetailsSummary(
  params: {
    title: string;
    company: string;
    location: string;
    listingText: string;
    fallbackSummary?: string;
  },
  gemini?: { apiKey: string; model?: string | null }
) {
  const listingSlice = params.listingText.slice(0, 12000);
  const fallback = normalizeGeneratedPlainText(
    [
      `Work: ${params.fallbackSummary?.trim() || params.title}`,
      "Stack: Not specified.",
      `Company: ${params.company}.`
    ].join("\n")
  );

  const overrideKey = gemini?.apiKey?.trim();
  const envKey = getGeminiApiKey()?.trim();
  const apiKey = overrideKey || envKey;

  const prompt = [
    "Summarize this single job for a candidate details panel.",
    "Use ONLY the job listing text and the Role, Company, and Location lines below.",
    "Do not use outside knowledge, other companies, or other job posts.",
    "Do not invent technologies, duties, or company descriptions not supported by the listing.",
    "Return exactly three lines with these labels: Work:, Stack:, Company:",
    "Work: day-to-day responsibilities for THIS role as stated or clearly implied in the listing only.",
    "Stack: tools, languages, frameworks, or platforms explicitly named in the listing; if none named, write exactly: Stack: Not specified.",
    "Company: what THIS listing says about the employer or team; if the listing barely describes the company, write exactly: Company: Not specified in listing.",
    "Keep under 320 characters total. No markdown.",
    `Role: ${params.title}`,
    `Company field: ${params.company}`,
    `Location field: ${params.location}`,
    `Job listing:\n${listingSlice}`
  ].join("\n\n");

  if (!apiKey) {
    return fallback;
  }

  const models = overrideKey
    ? Array.from(
        new Set([
          gemini?.model?.trim() || GEMINI_PRIMARY_MODEL,
          GEMINI_FALLBACK_MODEL,
          GEMINI_STABLE_FALLBACK_MODEL
        ])
      )
    : getGeminiModels();

  try {
    const text = await callGeminiGenerateWithKey([{ text: prompt }], apiKey, models);
    return normalizeGeneratedPlainText(text) || fallback;
  } catch {
    return fallback;
  }
}

export async function inferCompanyNameFromListing(
  params: {
    sourceUrl: string;
    title?: string;
    listingText: string;
    hints?: string[];
  },
  geminiOverride?: { apiKey: string; model?: string | null }
) {
  const hintBlock = (params.hints ?? []).map((hint) => hint.trim()).filter(Boolean);
  const apiKey = geminiOverride?.apiKey?.trim() || getGeminiApiKey()?.trim();

  if (!apiKey) {
    return hintBlock[0] ?? "";
  }

  const primaryModel = geminiOverride?.model?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  const prompt = [
    "Identify the employer/company name for this job listing.",
    "Return only the company name as plain text.",
    "Do not return 'unknown', 'n/a', 'not specified', or any explanation.",
    "Use the URL, job title, page text, and hints to infer the company if needed.",
    params.sourceUrl ? `Listing URL: ${params.sourceUrl}` : "",
    params.title ? `Job title: ${params.title}` : "",
    hintBlock.length ? `Hints: ${hintBlock.join(" | ")}` : "",
    `Listing text:\n${params.listingText.slice(0, 12000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = normalizeGeneratedPlainText(
        await callGeminiGenerateWithKey([{ text: prompt }], apiKey, models)
      );

      if (text && !/^unknown\b|^n\/a$|^not specified$/i.test(text)) {
        return text.split("\n")[0].trim();
      }
    } catch {
    }
  }

  return hintBlock[0] ?? "";
}

export async function inferJobListingCoreFields(
  params: {
    sourceUrl: string;
    listingText: string;
    fallback: { title: string; company: string; location: string; snippet: string };
    structuredHints?: string;
  },
  gemini: { apiKey: string; model?: string | null }
): Promise<{ title: string; company: string; location: string } | null> {
  const apiKey = gemini.apiKey.trim();

  if (!apiKey) {
    return null;
  }

  const primaryModel = gemini.model?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  const hintLines = [
    params.structuredHints?.trim() ? `Structured data hints from page:\n${params.structuredHints.trim()}` : "",
    `Search-result fallback (often truncated): title="${params.fallback.title}" company="${params.fallback.company}" location="${params.fallback.location}"`,
    params.fallback.snippet.trim() ? `Search snippet: ${params.fallback.snippet.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    "Extract exactly three fields from this job listing.",
    "Return JSON only: {\"title\":\"\",\"company\":\"\",\"location\":\"\"}.",
    "title: job role only (e.g. Software Engineer). Exclude employer name and location from title.",
    "company: legal or brand employer name that is hiring. Must not be a city, state, region, or country alone.",
    "location: workplace location as stated (city/state/country, multiple locations, or Remote/Hybrid).",
    "Ground every value in the listing text or structured hints. Do not invent employers.",
    "If uncertain for a field use empty string for that field.",
    `Listing URL: ${params.sourceUrl}`,
    hintLines,
    `Listing body text:\n${params.listingText.slice(0, 14000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const text = await callGeminiGenerateWithKey([{ text: prompt }], apiKey, models, { json: true });
    const parsed = parseJsonObject(text) as {
      title?: unknown;
      company?: unknown;
      location?: unknown;
    };

    return {
      title: String(parsed.title ?? "").trim(),
      company: String(parsed.company ?? "").trim(),
      location: String(parsed.location ?? "").trim()
    };
  } catch {
    return null;
  }
}

export async function generateFormAnswers(params: {
  contextBlock: string;
  listingText: string;
  fields: Array<{
    fieldId: string;
    key: string;
    label: string;
    type: string;
    required: boolean;
    options: string[];
  }>;
  resumeText?: string;
  resumePdf?: Buffer | null;
  coverLetterText?: string;
  writingSample?: string;
  attemptNote?: string;
  gemini?: { apiKey: string; model?: string | null };
}) {
  if (!params.fields.length) {
    return new Map<string, { answer: string; reasoning: string }>();
  }

  const geminiApiKey = params.gemini?.apiKey?.trim() || getGeminiApiKey()?.trim();

  if (!geminiApiKey) {
    return new Map<string, { answer: string; reasoning: string }>(
      params.fields.map((field) => [
        field.fieldId,
        {
          answer: "",
          reasoning: "No Gemini API key configured."
        }
      ])
    );
  }

  const primaryModel = params.gemini?.model?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);
  const prompt = [
    "You are filling a job application form.",
    "You will receive the entire visible form as JSON. Each field has a fieldId. Return answers keyed by the same fieldId.",
    "Read every field label literally. Do not move an answer from one field to another.",
    "For every answer, first identify what that exact field label is asking. The answer must fit that exact field label and its options.",
    "You must return exactly one answers item for every field in Fields JSON.",
    hasPdf
      ? "For required non-demographic fields, an empty answer is invalid. Use the candidate context and the attached resume PDF to answer them."
      : "For required non-demographic fields, an empty answer is invalid. Use the candidate context and resume to answer them.",
    hasPdf
      ? "Identity fields are mandatory when present: Full name must use the candidate name, Email must use the candidate email, Phone must use the candidate phone if present in context or resume PDF."
      : "Identity fields are mandatory when present: Full name must use the candidate name, Email must use the candidate email, Phone must use the candidate phone if present in context or resume.",
    "If a field asks for current location/city/state, answer only the location value, for example 'Chicago, IL'.",
    "Location answers must be under 80 characters.",
    "If a field asks how the candidate heard about the job, answer exactly 'Google'.",
    "How-heard/source answers must be exactly 'Google' and must not be a sentence about the candidate.",
    "Determine the field's intent semantically from its label, key, type, and options, not by keyword matching alone.",
    "If a field is asking for an uploaded supporting document or extra attachment that belongs with the application, treat that as a cover-letter request and use the provided cover letter text when the field expects text content.",
    "If a field is asking why the candidate would be a strong addition to the team or culture, answer it as a culture-fit question focused on soft skills, collaboration style, values, and personal strengths, not technical experience.",
    "For culture-fit questions, use the candidate writing sample as the style reference when one is provided.",
    "If and only if a field is semantically asking for a cover letter, letter of interest, uploaded supporting letter, or a long application statement, use the provided cover letter text.",
    "Never use the cover letter text for location, source/how-heard, authorization, short answer, URL, phone, or choice fields.",
    "If a field asks for a URL, answer only a URL. If a field asks for a phone number and no phone is present, answer empty string.",
    "Skip optional demographic/self-identification fields by returning empty string: pronouns, race, ethnicity, gender, disability, veteran, EEO, equal opportunity.",
    "For required demographic/self-identification choice fields, choose the option label equivalent to 'I do not wish to answer', 'Decline to self-identify', 'Prefer not to say', or 'I don't want to answer'.",
    "Never leave a required non-demographic field empty.",
    "For radio, checkbox, and select fields, answer using option labels from that field's options.",
    "For required radio, checkbox, and select fields, you must choose the best available option. For required demographic/self-identification fields, the best option is the opt-out equivalent.",
    "Never leave a required non-demographic choice field empty.",
    ...COMPENSATION_INSTRUCTIONS,
    "Use normal capitalization. Be concise, concrete, and truthful.",
    "Return valid JSON only with shape {\"answers\":[{\"fieldId\":\"\",\"answer\":\"\",\"reasoning\":\"\"}]}.",
    params.attemptNote ? `Critical retry note:\n${params.attemptNote}` : "",
    `Fields JSON:\n${JSON.stringify(params.fields)}`,
    `Candidate context:\n${params.contextBlock}`,
    !hasPdf && params.resumeText ? `Resume text:\n${params.resumeText}` : "",
    params.coverLetterText ? `Cover letter text:\n${params.coverLetterText}` : "",
    params.writingSample ? `Candidate writing sample:\n${params.writingSample.slice(0, 6000)}` : "",
    `Job listing text:\n${params.listingText.slice(0, 8000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdf) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: params.resumePdf.toString("base64")
      }
    });
  }

  try {
    const text = await callGeminiGenerateWithKey(parts, geminiApiKey, models, { json: true });
    const parsed = parseJsonObject(text) as {
      answers?: Array<{ fieldId?: string; answer?: string; reasoning?: string }>;
    };
    const validFieldIds = new Set(params.fields.map((field) => field.fieldId));
    const out = new Map<string, { answer: string; reasoning: string }>();

    for (const item of parsed.answers ?? []) {
      const fieldId = String(item.fieldId ?? "");

      if (!validFieldIds.has(fieldId)) {
        continue;
      }

      out.set(fieldId, {
        answer: String(item.answer ?? ""),
        reasoning: item.reasoning ?? "Answered from whole-form field dump."
      });
    }

    return out;
  } catch (err) {
    return new Map<string, { answer: string; reasoning: string }>(
      params.fields.map((field) => [
        field.fieldId,
        {
          answer: "",
          reasoning: err instanceof Error ? err.message : "Gemini returned unusable output."
        }
      ])
    );
  }
}

export async function classifyApplicationFieldIntent(params: {
  label: string;
  key?: string;
  type?: string;
  options?: string[];
}) {
  if (!hasGeminiKey()) {
    return "other" as const;
  }

  const prompt = [
    "Classify the intent of exactly one job application field.",
    "Determine intent semantically from the label, key, type, and options. Do not rely on keyword matching alone.",
    "Return JSON only with shape {\"intent\":\"cover_letter_upload\"} or {\"intent\":\"culture_fit\"} or {\"intent\":\"other\"}.",
    "Use cover_letter_upload when the field is asking for an uploaded supporting document or additional file that should be a cover letter.",
    "Use culture_fit when the field is asking why the candidate would be a good addition to the team, culture, or work environment.",
    `Field label: ${params.label}`,
    `Field key: ${params.key ?? ""}`,
    `Field type: ${params.type ?? ""}`,
    `Available options: ${JSON.stringify(params.options ?? [])}`
  ].join("\n\n");

  const text = await callGeminiText(prompt, { json: true });
  const parsed = parseJsonObject(text) as { intent?: string };
  const intent = String(parsed.intent ?? "");

  if (intent === "cover_letter_upload" || intent === "culture_fit" || intent === "other") {
    return intent;
  }

  throw new Error(`Unrecognized field intent: ${intent || "empty"}`);
}

export async function generateTailoredCoverLetterText(params: {
  profileBlock: string;
  resumeText?: string;
  resumePdf?: Buffer | null;
  listingText: string;
  writingSample?: string;
  coverLetterTemplate?: string;
  companyAboutText?: string;
  company: string;
  roleTitle: string;
  language?: AppLanguage;
}) {
  const language = params.language ?? "en";
  const fallback = normalizeGeneratedPlainText(
    [
      translate("coverGreeting", undefined, language),
      "",
      `I am applying for the ${params.roleTitle} role at ${params.company}.`,
      "",
      params.profileBlock,
      "",
      translate("coverClosing", undefined, language)
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (!hasGeminiKey()) {
    return fallback;
  }

  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);
  const prompt = [
    "Write a concise, truthful cover letter tailored to this job.",
    hasPdf
      ? "Use only the candidate profile and the attached resume PDF. Do not invent employers, degrees, dates, or metrics."
      : "Use only the candidate profile and existing resume text. Do not invent employers, degrees, dates, or metrics.",
    "Use the candidate writing sample as the style reference: sentence rhythm, directness, vocabulary, and level of formality should follow that sample.",
    "Replace the relevant experience described in this with experience the user acutally has in their work history that's relevant to this role.",
    "If a cover letter template is provided, use it as the main structure, tone, and length reference. You may adapt wording and details for the role, but stay close to its general feel.",
    "Do not copy placeholders from the template. Replace or omit anything that cannot be supported by the candidate profile, resume, company context, or listing.",
    "Avoid generic AI cover-letter phrasing like 'I am excited to apply', 'I am confident I can contribute', and 'I look forward to the opportunity'.",
    "Use plain ASCII punctuation only. Do not use em dashes, en dashes, curly quotes, bullets, special symbols, or decorative characters.",
    "No trailing spaces. Use normal line endings and short paragraphs.",
    "Keep it plain text, 3 to 5 short paragraphs, and ready to paste into an application form.",
    "Address it to the hiring team unless a specific contact is provided.",
    `Write the response in ${language === "fr" ? "French" : "English"}.`,
    `Target role: ${params.roleTitle}`,
    `Company: ${params.company}`,
    `Candidate profile:\n${params.profileBlock}`,
    !hasPdf && params.resumeText ? `Existing resume text:\n${params.resumeText}` : "",
    params.coverLetterTemplate ? `Cover letter template for tone, structure, and length:\n${params.coverLetterTemplate.slice(0, 6000)}` : "",
    params.writingSample ? `Candidate writing sample for style:\n${params.writingSample.slice(0, 6000)}` : "",
    params.companyAboutText ? `Company about/context page text:\n${params.companyAboutText.slice(0, 7000)}` : "",
    `Job listing:\n${params.listingText.slice(0, 8000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdf) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: params.resumePdf.toString("base64")
      }
    });
  }

  try {
    const text = await callGeminiGenerate(parts);
    return normalizeGeneratedPlainText(text) || fallback;
  } catch {
    return fallback;
  }
}

export async function generateHiringContactEmail(params: {
  profileBlock: string;
  resumeText?: string;
  resumePdf?: Buffer | null;
  listingText: string;
  company: string;
  roleTitle: string;
  contact: string;
  followUp?: boolean;
  language?: AppLanguage;
}) {
  const language = params.language ?? "en";
  const subject = params.followUp
    ? translate("followUpSubject", { role: params.roleTitle }, language)
    : `${params.roleTitle} application`;
  const fallbackBody = normalizeGeneratedPlainText(
    params.followUp
      ? [
          "Hi,",
          "",
          translate("followUpBody", { role: params.roleTitle, company: params.company }, language),
          "",
          "Best,",
          params.profileBlock.match(/^Name:\s*(.+)$/m)?.[1] ?? ""
        ].join("\n")
      : [
          "Hi,",
          "",
          translate("directApplicationBody", { role: params.roleTitle, company: params.company }, language),
          "",
          "Best,",
          params.profileBlock.match(/^Name:\s*(.+)$/m)?.[1] ?? ""
        ].join("\n")
  );

  if (!hasGeminiKey()) {
    return { subject, body: fallbackBody };
  }

  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);
  const prompt = [
    params.followUp
      ? "Write a short plain-text follow-up email to a hiring contact after the candidate applied a few days ago."
      : "Write a short plain-text email to a hiring contact about a job application.",
    hasPdf
      ? "Use the candidate context and the attached resume PDF only. Do not invent facts."
      : "Use the candidate context and resume only. Do not invent facts.",
    "Keep it direct and human. Under 120 words.",
    "Use plain ASCII punctuation only.",
    `Write the email in ${language === "fr" ? "French" : "English"}.`,
    "Return JSON only: {\"subject\":\"\",\"body\":\"\"}.",
    `Contact: ${params.contact}`,
    `Role: ${params.roleTitle}`,
    `Company: ${params.company}`,
    `Candidate context:\n${params.profileBlock}`,
    !hasPdf && params.resumeText ? `Resume text:\n${params.resumeText.slice(0, 6000)}` : "",
    `Job listing:\n${params.listingText.slice(0, 6000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts: GeminiUserPart[] = [{ text: prompt }];

  if (hasPdf && params.resumePdf) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: params.resumePdf.toString("base64")
      }
    });
  }

  try {
    const text = await callGeminiGenerate(parts, { json: true });
    const parsed = parseJsonObject(text) as { subject?: string; body?: string };
    return {
      subject: normalizeGeneratedPlainText(parsed.subject ?? subject) || subject,
      body: normalizeGeneratedPlainText(parsed.body ?? fallbackBody) || fallbackBody
    };
  } catch {
    return { subject, body: fallbackBody };
  }
}
