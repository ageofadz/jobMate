import type { FieldAnswer } from "@/lib/types";

import { translate, type AppLanguage } from "@/lib/i18n";
import { getGeminiApiKey, getGeminiModel } from "@/lib/settings-store";
import {
  buildApplyAnchorUrls,
  isOffTargetJobUrl,
  isReturnToListingUrl
} from "@/lib/apply-target-scope";
import { buildPageObservation, routeBrowserAction, ROUTER_CHEAP_MODEL } from "@/lib/browser-agent-router";
import type { BrowserAction, BrowserStepHistoryItem, BrowserTool, PageElement } from "@/lib/browser-agent-types";

export type {
  BrowserAction,
  BrowserCoords,
  BrowserStepHistoryItem,
  BrowserTool,
  OcrBlock,
  PageElement,
  ViewportSize
} from "@/lib/browser-agent-types";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

const GEMINI_PRIMARY_MODEL = "gemini-3.1-flash-lite";
const GEMINI_FALLBACK_MODEL = "gemini-2-flash";
const GEMINI_STABLE_FALLBACK_MODEL = "gemini-3.1-flash-lite";

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error("Empty LLM output.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // ignored
  }

  const start = candidate.indexOf("{");

  if (start < 0) {
    throw new Error("LLM output did not contain a JSON object.");
  }

  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inStr = !inStr;
      continue;
    }

    if (inStr) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;

      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }

  throw new Error("LLM output did not contain a complete JSON object.");
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
      ? "Use the provided candidate context and attached resume PDF."
      : "Use the provided candidate context and resume text.",
    "Return exactly one answer per field key in Fields JSON.",
    "Read each field label, type, and options literally.",
    "Required fields must be non-empty.",
    "For select, radio, and checkbox fields, return the exact text of one listed option.",
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
    "Read the field label, type, and options literally.",
    "Required fields must be non-empty.",
    "For select, radio, and checkbox fields, return the exact text of one listed option.",
    hasPdf
      ? "Use the candidate context and attached resume PDF."
      : "Use the candidate context and resume text.",
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
    "Return exactly one answer per fieldId in Fields JSON.",
    "Read each field label, type, and options literally.",
    "Required fields must be non-empty.",
    "For select, radio, and checkbox fields, return the exact text of one listed option.",
    "For file fields: resume/CV upload → \"__resume__\"; cover letter upload → \"__cover_letter__\"; otherwise empty string.",
    hasPdf
      ? "Use candidate context, listing, and attached resume PDF."
      : "Use candidate context and listing.",
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
  gemini?: { apiKey: string; model?: string | null };
}) {
  const geminiApiKey = params.gemini?.apiKey?.trim() || getGeminiApiKey()?.trim();

  if (!geminiApiKey) {
    throw new Error("Gemini API key is required to classify application field intent.");
  }

  const primaryModel = params.gemini?.model?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  const prompt = [
    "Classify the intent of exactly one job application field.",
    "Determine intent semantically from the label, key, type, and options.",
    "Return JSON only with shape {\"intent\":\"cover_letter_upload\"} or {\"intent\":\"culture_fit\"} or {\"intent\":\"other\"}.",
    "Use cover_letter_upload when the field is asking for a cover letter, letter of interest, motivation letter, message to the recruitment or hiring team, supporting letter, or long supporting statement, whether the UI expects a file upload or free text (textarea, text entry, or paste).",
    "Use cover_letter_upload when the field asks what motivates the candidate, why they want to join, or why this role is their next challenge, if the answer is expected to be a long free-text application statement rather than a short culture-fit blurb.",
    "Use cover_letter_upload when the field type is file and the surrounding form section is clearly for a cover or supporting letter even if the visible label only says Attach, Upload, or similar.",
    "Use culture_fit only for short questions about team fit or culture where a brief answer is expected, not a full motivation statement.",
    `Field label: ${params.label}`,
    `Field key: ${params.key ?? ""}`,
    `Field type: ${params.type ?? ""}`,
    `Available options: ${JSON.stringify(params.options ?? [])}`
  ].join("\n\n");

  const text = await callGeminiGenerateWithKey([{ text: prompt }], geminiApiKey, models, { json: true });
  const parsed = parseJsonObject(text) as { intent?: string };
  const intent = String(parsed.intent ?? "");

  if (intent === "cover_letter_upload" || intent === "culture_fit" || intent === "other") {
    return intent;
  }

  throw new Error(`Unrecognized field intent: ${intent || "empty"}`);
}

export type ApplyPageActionInput = {
  actionId: string;
  text: string;
  tag: string;
  href: string;
  context: string;
};

export type ApplyPageFieldInput = {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizePageUrl(url: string, base: string) {
  try {
    const parsed = new URL(url, base);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

export async function nextBrowserAction(params: {
  pageUrl: string;
  pageText: string;
  stepIndex: number;
  history: BrowserStepHistoryItem[];
  targetApplyUrl: string;
  targetTitle: string;
  targetCompany: string;
  candidateEmail: string;
  hiddenApplyUrl?: string | null;
  hasLeftTargetListing?: boolean;
  listingText: string;
  elements: PageElement[];
  blockedElementIds?: string[];
  gemini?: { apiKey: string; model?: string | null };
}): Promise<BrowserAction> {
  const geminiApiKey = params.gemini?.apiKey?.trim() || getGeminiApiKey()?.trim();
  if (!geminiApiKey) {
    throw new Error("Gemini API key required.");
  }

  const cheapModel = params.gemini?.model?.trim() || getGeminiModel() || ROUTER_CHEAP_MODEL;
  const applyAnchorUrls = buildApplyAnchorUrls(params.targetApplyUrl, params.hiddenApplyUrl);
  const leftListing = Boolean(params.hasLeftTargetListing);
  const blockedIds = new Set((params.blockedElementIds ?? []).map(String));

  const domActions = params.elements.filter((e) => e.type === "action");
  const elementActions = params.elements.filter(
    (e) =>
      e.type === "action" &&
      !blockedIds.has(e.elementId) &&
      !(e.href && isOffTargetJobUrl(e.href, applyAnchorUrls, params.pageUrl)) &&
      !(leftListing && e.href && isReturnToListingUrl(e.href, params.targetApplyUrl, params.pageUrl))
  );
  const actions = elementActions.length ? elementActions : domActions.filter((e) => !blockedIds.has(e.elementId));

  const observation = buildPageObservation({
    pageUrl: params.pageUrl,
    pageText: params.pageText,
    stepIndex: params.stepIndex,
    history: params.history,
    hiddenApplyUrl: params.hiddenApplyUrl,
    elements: params.elements,
    blockedElementIds: params.blockedElementIds,
    hasLeftTargetListing: params.hasLeftTargetListing,
    targetApplyUrl: params.targetApplyUrl,
    targetTitle: params.targetTitle,
    targetCompany: params.targetCompany,
    actions,
    allActions: actions
  });

  try {
    return await routeBrowserAction(geminiApiKey, cheapModel, observation);
  } catch (err) {
    return {
      tool: "blocked",
      elementId: null,
      url: null,
      text: null,
      value: null,
      reasoning: err instanceof Error ? err.message : String(err),
      coverLetterElementIds: [],
      coverLetterRevealIds: [],
      resumeElementIds: []
    };
  }
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
  pageLanguage?: string;
  gemini?: { apiKey: string; model?: string | null };
}) {
  const language = params.language ?? "en";
  const pageLanguage = params.pageLanguage?.trim().toLowerCase() || "";
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

  const geminiApiKey = params.gemini?.apiKey?.trim() || getGeminiApiKey()?.trim();

  if (!geminiApiKey) {
    return fallback;
  }

  const primaryModel = params.gemini?.model?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));
  const hasPdf = Boolean(params.resumePdf && params.resumePdf.length > 0);


  const prompt = [

    "Write a short application note for this job. This is not a formal cover letter.",

    "",

    "Goal:",

    "Sound like a real person briefly explaining why this role makes sense for them.",

    "- Reference specifics from the listing if possible.",

    "The note should be specific, direct, and slightly understated.",

    "",

    "Hard constraints:",

    "- 2 to 3 short paragraphs only.",

    "- 120 to 220 words total.",

    "- No bullets.",

    "- Plain text only.",

    pageLanguage
      ? `- Write the entire note in the same language as the job application page (BCP-47 language code: ${pageLanguage}). Do not use English unless that code is en.`
      : `- Write the entire note in ${language === "fr" ? "French" : "English"}.`,

    "- Address it to the hiring team unless a specific contact is provided.",

    "- Use correct spelling and diacritics for the target language.",

    "- Do not invent employers, degrees, dates, metrics, locations, titles, clients, or domain experience.",

    "- Do not claim the candidate has experience unless it is explicitly supported by the profile or resume.",

    "",

    "Style rules:",

    "- Use the candidate writing sample as the style reference.",

    "- Prefer simple, concrete sentences.",

    "- Avoid polished corporate language.",

    "- Avoid sounding eager, inspirational, or overly impressed.",

    "- Avoid generic AI cover-letter phrasing.",

    "- Do not use these phrases or close variants: 'I am excited to apply', 'I am confident I can contribute', 'leverage my background', 'particularly interesting', 'core product', 'complex operations', 'dynamic team', 'fast-paced environment', 'mission-driven', 'passionate about', 'perfect fit', 'unique opportunity', 'I look forward to'.",

    "",

    "Content rules:",

    "- Start with the actual reason the role is interesting, based on the job listing.",

    "- Then connect 1 or 2 specific pieces of the candidate's real experience to the role.",

    "- If the domain is new to the candidate, say it indirectly by focusing on transferable workflow/system experience. Do not pretend domain expertise.",

    "- Prefer specific work patterns over broad labels.",

    "- Mention the company name at most once.",

    "- Mention the role title at most once.",

    "- Finish with a link to my portfolio/github/public resume link, etc. if available, and a friendly invitation to follow up.",

    "",

    `Job listing:\n${params.listingText.slice(0, 8000)}`,

    `Resume text:\n${params.resumeText ?? ""}`,

    `Candidate writing sample:\n${params.writingSample ?? ""}`,
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
    const text = await callGeminiGenerateWithKey(parts, geminiApiKey, models);
    return normalizeGeneratedPlainText(text) || fallback;
  } catch {
    return fallback;
  }
}

export async function jobMatchesTargetLocations(params: {
  geminiApiKey: string;
  geminiModel?: string | null;
  jobLocation: string;
  listingText: string;
  targetLocations: string[];
}): Promise<boolean> {
  if (!params.targetLocations.length) {
    return true;
  }

  const apiKey = params.geminiApiKey.trim();

  if (!apiKey) {
    throw new Error("Gemini API key is required for location matching.");
  }

  const primaryModel = params.geminiModel?.trim() || getGeminiModel() || GEMINI_PRIMARY_MODEL;
  const models = Array.from(new Set([primaryModel, GEMINI_FALLBACK_MODEL, GEMINI_STABLE_FALLBACK_MODEL]));

  const prompt = [
    "Decide whether this job listing's work location matches any of the candidate's target search locations.",
    "Return JSON only: {\"matches\": true} or {\"matches\": false}.",
    "Accept remote or hybrid roles when they are compatible with the target region or country.",
    "Reject jobs clearly based in a different city, state, or country than every target location.",
    `Target locations: ${params.targetLocations.join("; ")}`,
    `Parsed job location: ${params.jobLocation.trim() || "(not stated)"}`,
    `Listing excerpt:\n${params.listingText.slice(0, 4000)}`
  ].join("\n\n");

  const text = await callGeminiGenerateWithKey([{ text: prompt }], apiKey, models, { json: true });
  const parsed = parseJsonObject(text) as { matches?: unknown };

  return parsed.matches === true;
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
