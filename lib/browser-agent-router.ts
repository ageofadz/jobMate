import {
  buildApplyAnchorUrls,
  isAllowedNavigateUrl,
  isOffTargetJobUrl,
  isReturnToListingUrl,
  isStemChildApplyPath,
  normalizeApplyScopeUrl,
  prioritizeActionsForClassifier,
  rankScopedApplyAdvancingActions,
  resolveStemChildActionUrl
} from "@/lib/apply-target-scope";
import type {
  BrowserAction,
  BrowserCoords,
  BrowserStepHistoryItem,
  BrowserTool,
  OcrBlock,
  PageElement,
  ViewportSize
} from "@/lib/browser-agent-types";

export type { OcrBlock, ViewportSize, BrowserCoords } from "@/lib/browser-agent-types";

export const ROUTER_CHEAP_MODEL = "gemini-3.1-flash-lite";
export const ROUTER_STRONG_MODEL = "gemini-2.5-pro";
const CLASSIFIER_ACTION_LIMIT = 120;

export type BrowserPhase = "pre_apply" | "application_form" | "auth_form";

export type NetworkObservation = {
  requestId?: string;
  method: string;
  url: string;
  resourceType?: string;
  status: number | null;
  mimeType: string | null;
  timestamp?: number;
};

export type PageObservation = {
  pageUrl: string;
  pageText: string;
  pageHost: string;
  stepIndex: number;
  phase: BrowserPhase;
  preApplyPhase: boolean;
  targetApplyUrl: string;
  targetTitle: string;
  targetCompany: string;
  hiddenApplyUrl: string | null;
  leftListing: boolean;
  fields: PageElement[];
  actions: PageElement[];
  allActions: PageElement[];
  blockedIds: Set<string>;
  history: BrowserStepHistoryItem[];
  allowedUrls: Set<string>;
  applyAnchorUrls: string[];
  networkObservations: NetworkObservation[];
  ocrBlocks: OcrBlock[];
  viewport: ViewportSize | null;
  ocrImageSize: ViewportSize | null;
  ambiguous: boolean;
  stuck: boolean;
};

export type DeterministicCandidates = {
  applyAdvancingIds: string[];
  formAdvancingIds: string[];
  navigateUrls: string[];
  rankedIds: string[];
};

type GeminiPart = { text: string };

function routerResolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return "";
  }
}

function routerPageHost(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isApplicationFormPhase(fields: PageElement[]): boolean {
  return (
    fields.some((f) => f.fieldType === "file" || f.fieldType === "textarea" || f.fieldType === "contenteditable") ||
    fields.length >= 8
  );
}

function isAuthOnlyFormPhase(fields: PageElement[]): boolean {
  if (!fields.length) return false;
  const hasPassword = fields.some((f) => f.fieldType === "password");
  return hasPassword && !isApplicationFormPhase(fields);
}

export function detectBrowserPhase(fields: PageElement[]): BrowserPhase {
  if (!isApplicationFormPhase(fields) && !isAuthOnlyFormPhase(fields)) return "pre_apply";
  if (isAuthOnlyFormPhase(fields)) return "auth_form";
  return "application_form";
}

function parseRouterJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty LLM output.");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("LLM output did not contain a JSON object.");
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
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>;
      }
    }
    throw new Error("LLM output did not contain a complete JSON object.");
  }
}

export async function callGeminiRouterSingle(
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  json: boolean
): Promise<string> {
  const resolvedModel = model || ROUTER_CHEAP_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: json ? { responseMimeType: "application/json" } : undefined
      }),
      signal: AbortSignal.timeout(90000)
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${resolvedModel}: ${res.status}${txt ? ` ${txt.slice(0, 300)}` : ""}`);
  }
  const payload = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.flatMap((c) => c.content?.parts ?? []).map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error(`${resolvedModel}: empty response`);
  return text;
}

function formatActionsForClassifier(actions: PageElement[]): string {
  return actions
    .map((e) => {
      let line = `elementId="${e.elementId}" [${e.tag}] "${String(e.text || "").slice(0, 80)}"`;
      if (e.href) line += ` url="${e.href.slice(0, 120)}"`;
      return line;
    })
    .join("\n");
}

function ocrBlockCenter(block: OcrBlock): BrowserCoords {
  return {
    x: Math.round((block.x0 + block.x1) / 2),
    y: Math.round((block.y0 + block.y1) / 2)
  };
}

function formatOcrBlocks(ocrBlocks: OcrBlock[]): string {
  return ocrBlocks
    .map((block, index) => {
      const center = ocrBlockCenter(block);
      return `${index}: "${String(block.text || "").slice(0, 80)}" box=[${block.x0},${block.y0},${block.x1},${block.y1}] center=[${center.x},${center.y}]`;
    })
    .join("\n");
}

function coordsFromParsed(parsed: Record<string, unknown>, ocrBlocks: OcrBlock[]): BrowserCoords | null {
  const blockIndexRaw = parsed.blockIndex;
  if (blockIndexRaw !== null && blockIndexRaw !== undefined && blockIndexRaw !== "") {
    const blockIndex = Number(blockIndexRaw);
    if (Number.isFinite(blockIndex) && blockIndex >= 0 && blockIndex < ocrBlocks.length) {
      return ocrBlockCenter(ocrBlocks[blockIndex]);
    }
  }
  const coords = parsed.coords as { x?: unknown; y?: unknown } | null;
  if (coords && Number.isFinite(Number(coords.x)) && Number.isFinite(Number(coords.y))) {
    const x = Math.round(Number(coords.x));
    const y = Math.round(Number(coords.y));
    if (x >= 0 && x <= 1000 && y >= 0 && y <= 1000) {
      return { x, y };
    }
  }
  return null;
}

function coordBlockKey(coords: BrowserCoords): string {
  return `coord:${coords.x},${coords.y}`;
}

function validateRankedActionIds(
  rawIds: string[],
  actions: PageElement[],
  blockedIds: Set<string>,
  guardFail: (action: PageElement | undefined) => boolean
): string[] {
  const actionById = new Map(actions.map((a) => [a.elementId, a]));
  const out: string[] = [];
  for (const id of rawIds) {
    const sid = String(id);
    if (blockedIds.has(sid)) continue;
    const action = actionById.get(sid);
    if (!action) continue;
    if (guardFail(action)) continue;
    if (!out.includes(sid)) out.push(sid);
  }
  return out;
}

function compactHistory(history: BrowserStepHistoryItem[], limit: number) {
  return history.slice(-limit).map((h) => {
    const out: Record<string, unknown> = { t: h.tool };
    if (h.elementId) out.el = h.elementId;
    if (h.url) out.url = h.url;
    if (h.reasoning) out.r = h.reasoning.slice(0, 60);
    return out;
  });
}

function axActionGuardFail(
  picked: PageElement | undefined,
  applyAnchorUrls: string[],
  pageUrl: string,
  leftListing: boolean,
  targetApplyUrl: string
): boolean {
  if (!picked) return true;
  const href = picked.href ?? "";
  if (!href) return false;
  if (isOffTargetJobUrl(href, applyAnchorUrls, pageUrl)) return true;
  if (leftListing && isReturnToListingUrl(href, targetApplyUrl, pageUrl)) return true;
  return false;
}

function buildAllowedUrls(
  applyAnchorUrls: string[],
  pageUrl: string,
  pageHost: string,
  targetApplyUrl: string,
  hiddenApplyUrl: string | null,
  leftListing: boolean
): Set<string> {
  const allowed = new Set<string>();
  for (const candidate of applyAnchorUrls) {
    const resolved = routerResolveUrl(candidate, pageUrl);
    if (resolved && isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl, hiddenApplyUrl, leftListing)) {
      allowed.add(resolved);
    }
  }
  return allowed;
}

function isAmbiguous(rankIds: string[], deterministicCount: number): boolean {
  if (rankIds.length > 1) return true;
  if (rankIds.length === 0 && deterministicCount === 0) return true;
  return false;
}

function isStuck(history: BrowserStepHistoryItem[], blockedIds: Set<string>): boolean {
  const recent = history.slice(-4);
  const failedClicks = recent.filter((h) => h.tool === "click" || h.tool === "submit").length;
  return blockedIds.size >= 2 || failedClicks >= 2;
}

export function buildPageObservation(input: {
  pageUrl: string;
  pageText: string;
  stepIndex: number;
  history: BrowserStepHistoryItem[];
  hiddenApplyUrl?: string | null;
  elements: PageElement[];
  blockedElementIds?: string[];
  hasLeftTargetListing?: boolean;
  targetApplyUrl: string;
  targetTitle: string;
  targetCompany: string;
  actions: PageElement[];
  allActions?: PageElement[];
  networkObservations?: NetworkObservation[];
  ocrBlocks?: OcrBlock[];
  viewport?: ViewportSize | null;
  ocrImageSize?: ViewportSize | null;
}): PageObservation {
  const blockedIds = new Set((input.blockedElementIds ?? []).map(String));
  const fields = input.elements.filter((e) => e.type === "field");
  const phase = detectBrowserPhase(fields);
  const pageHost = routerPageHost(input.pageUrl);
  const leftListing = Boolean(input.hasLeftTargetListing);
  const applyAnchorUrls = buildApplyAnchorUrls(input.targetApplyUrl, input.hiddenApplyUrl);
  const allowedUrls = buildAllowedUrls(
    applyAnchorUrls,
    input.pageUrl,
    pageHost,
    input.targetApplyUrl,
    input.hiddenApplyUrl ?? null,
    leftListing
  );

  return {
    pageUrl: input.pageUrl,
    pageText: String(input.pageText || ""),
    pageHost,
    stepIndex: input.stepIndex,
    phase,
    preApplyPhase: phase === "pre_apply",
    targetApplyUrl: input.targetApplyUrl,
    targetTitle: input.targetTitle,
    targetCompany: input.targetCompany,
    hiddenApplyUrl: input.hiddenApplyUrl ?? null,
    leftListing,
    fields,
    actions: input.actions,
    allActions: input.allActions ?? input.actions,
    blockedIds,
    history: input.history,
    allowedUrls,
    applyAnchorUrls,
    networkObservations: input.networkObservations ?? [],
    ocrBlocks: input.ocrBlocks ?? [],
    viewport: input.viewport ?? null,
    ocrImageSize: input.ocrImageSize ?? null,
    ambiguous: false,
    stuck: isStuck(input.history, blockedIds)
  };
}

export function buildDeterministicCandidates(observation: PageObservation): DeterministicCandidates {
  const guardFail = (picked: PageElement | undefined) =>
    axActionGuardFail(
      picked,
      observation.applyAnchorUrls,
      observation.pageUrl,
      observation.leftListing,
      observation.targetApplyUrl
    );

  if (observation.phase === "pre_apply") {
    const applyAdvancingIds = rankScopedApplyAdvancingActions(
      observation.actions,
      observation.applyAnchorUrls,
      observation.pageUrl,
      (action) => guardFail(observation.actions.find((a) => a.elementId === action.elementId))
    );
    const navigateUrls: string[] = [];
    for (const candidate of observation.allowedUrls) {
      if (normalizeApplyScopeUrl(candidate, observation.pageUrl) !== normalizeApplyScopeUrl(observation.pageUrl, observation.pageUrl)) {
        navigateUrls.push(candidate);
      }
    }
    return { applyAdvancingIds, formAdvancingIds: [], navigateUrls, rankedIds: applyAdvancingIds };
  }

  return {
    applyAdvancingIds: [],
    formAdvancingIds: [],
    navigateUrls: [...observation.allowedUrls],
    rankedIds: []
  };
}

async function rankCandidatesWithCheapModel(
  apiKey: string,
  model: string,
  observation: PageObservation,
  candidates: DeterministicCandidates,
  rankKind: "apply" | "form"
): Promise<{ rankedIds: string[]; reasoning: string }> {
  const guardFail = (picked: PageElement | undefined) =>
    axActionGuardFail(
      picked,
      observation.applyAnchorUrls,
      observation.pageUrl,
      observation.leftListing,
      observation.targetApplyUrl
    );

  const classifierActions = prioritizeActionsForClassifier(
    observation.actions,
    observation.applyAnchorUrls,
    observation.pageUrl,
    CLASSIFIER_ACTION_LIMIT
  );

  const compact = compactHistory(observation.history, 3);
  const actionsText = formatActionsForClassifier(classifierActions);
  const ocrText = formatOcrBlocks(observation.ocrBlocks);
  const resultKey = rankKind === "apply" ? "applyAdvancing" : "formAdvancing";

  const prompt = [
    rankKind === "apply"
      ? "Rank interactive controls that advance the user's application to the target job they selected."
      : "Rank interactive controls that advance the current application form step for the target job the user selected.",
    `Return exactly: {"${resultKey}":["elementId",...],"reasoning":""}`,
    "Order best-first. Only use elementIds from INTERACTIVE ELEMENTS.",
    rankKind === "apply" ? "Buttons and links without URLs that start the application on this page must be ranked." : "",
    rankKind === "apply" ? "The primary apply control on the page should be ranked first." : "",
    observation.targetTitle
      ? `Target job: "${observation.targetTitle}" at ${observation.targetCompany}`
      : "Target: the job the user chose to apply to",
    `Target URL: ${observation.targetApplyUrl}`,
    observation.hiddenApplyUrl ? `Hidden apply URL: ${observation.hiddenApplyUrl}` : "",
    `Current page: ${observation.pageUrl}`,
    rankKind === "form" ? `Visible form fields: ${observation.fields.length}` : "",
    compact.length ? `Recent actions: ${JSON.stringify(compact)}` : "",
    ocrText ? `OCR_BLOCKS (normalized 0-1000):\n${ocrText}` : "",
    actionsText ? `INTERACTIVE ELEMENTS:\n${actionsText}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  if (rankKind === "apply" && candidates.applyAdvancingIds.length === 1) {
    return { rankedIds: candidates.applyAdvancingIds, reasoning: "Same-job-scope apply link." };
  }

  if (rankKind === "apply" && candidates.applyAdvancingIds.length > 1) {
    const scope = new Set(candidates.applyAdvancingIds);
    const scopeActions = observation.actions.filter((a) => scope.has(a.elementId));
    if (scopeActions.length) {
      const scopedText = formatActionsForClassifier(
        prioritizeActionsForClassifier(scopeActions, observation.applyAnchorUrls, observation.pageUrl, CLASSIFIER_ACTION_LIMIT)
      );
      const scopedPrompt = [...prompt.split("\n\n").slice(0, -1), `INTERACTIVE ELEMENTS:\n${scopedText}`].join("\n\n");
      const scopedRaw = await callGeminiRouterSingle(apiKey, model, [{ text: scopedPrompt }], true);
      const scopedParsed = parseRouterJson(scopedRaw);
      const scopedIds = Array.isArray(scopedParsed[resultKey]) ? scopedParsed[resultKey].map(String) : [];
      const scopedRanked = validateRankedActionIds(scopedIds, scopeActions, observation.blockedIds, guardFail);
      if (scopedRanked.length) {
        return { rankedIds: scopedRanked, reasoning: String(scopedParsed.reasoning ?? "") };
      }
    }
  }

  const raw = await callGeminiRouterSingle(apiKey, model, [{ text: prompt }], true);
  const parsed = parseRouterJson(raw);
  const rawIds = Array.isArray(parsed[resultKey]) ? parsed[resultKey].map(String) : [];
  return {
    rankedIds: validateRankedActionIds(rawIds, observation.actions, observation.blockedIds, guardFail),
    reasoning: String(parsed.reasoning ?? "")
  };
}

async function recoverWithStrongModel(
  apiKey: string,
  observation: PageObservation,
  rankedIds: string[],
  rankReasoning: string
): Promise<BrowserAction> {
  const guardFail = (picked: PageElement | undefined) =>
    axActionGuardFail(
      picked,
      observation.applyAnchorUrls,
      observation.pageUrl,
      observation.leftListing,
      observation.targetApplyUrl
    );

  const compact = compactHistory(observation.history, 5);
  const ocrText = formatOcrBlocks(observation.ocrBlocks);
  const networkText = observation.networkObservations
    .slice(0, 12)
    .map((n) => `${n.method} ${n.url} status=${n.status ?? "pending"} type=${n.resourceType || ""}`)
    .join("\n");

  const prompt = (observation.ocrBlocks.length
    ? [
        observation.phase === "pre_apply"
          ? "Choose the OCR text block to click to start or advance the job application."
          : "Choose the OCR text block to click to advance the current application form step.",
        '{"tool":"click|navigate|wait|blocked","blockIndex":null,"url":null,"reasoning":""}',
        "Pick blockIndex from OCR_BLOCKS. The click happens at the center of that box.",
        "Do not reference DOM elements or elementIds.",
        observation.leftListing ? "Do not navigate back to the listing page." : "",
        observation.targetTitle ? `Job: "${observation.targetTitle}" at ${observation.targetCompany}` : "Target: apply on this page",
        `Target URL: ${observation.targetApplyUrl}`,
        `Current: ${observation.pageUrl} (step ${observation.stepIndex})`,
        observation.blockedIds.size ? `Skip these (already tried): ${[...observation.blockedIds].join(", ")}` : "",
        compact.length ? `Recent actions: ${JSON.stringify(compact)}` : "",
        observation.allowedUrls.size ? `Allowed navigate URLs: ${JSON.stringify([...observation.allowedUrls])}` : "",
        networkText ? `Recent network:\n${networkText}` : "",
        `OCR_BLOCKS:\n${ocrText}`
      ]
    : [
        observation.phase === "pre_apply"
          ? "You are choosing the control that starts or advances the job application for the target job."
          : "You are recovering a stuck job application browser step.",
        "Choose ONE action that advances the current step toward submission.",
        '{"tool":"click|submit|navigate|wait|blocked","elementId":null,"url":null,"reasoning":""}',
        observation.leftListing ? "Do not navigate back to the listing page." : "",
        observation.targetTitle ? `Job: "${observation.targetTitle}" at ${observation.targetCompany}` : "Target: apply on this page",
        `Target URL: ${observation.targetApplyUrl}`,
        `Current: ${observation.pageUrl} (step ${observation.stepIndex})`,
        observation.blockedIds.size ? `Skip these (already tried): ${[...observation.blockedIds].join(", ")}` : "",
        compact.length ? `Recent actions: ${JSON.stringify(compact)}` : "",
        observation.allowedUrls.size ? `Allowed navigate URLs: ${JSON.stringify([...observation.allowedUrls])}` : "",
        `Form with ${observation.fields.length} fields is present. Extension fills fields automatically.`,
        rankReasoning ? `Prior rank reasoning: ${rankReasoning}` : "",
        networkText ? `Recent network:\n${networkText}` : "",
        `PAGE TEXT:\n${observation.pageText.slice(0, 1500)}`
      ])
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouterSingle(apiKey, ROUTER_STRONG_MODEL, [{ text: prompt }], true);
  const parsed = parseRouterJson(raw);

  const toolRaw = String(parsed.tool ?? "");
  const validTools: BrowserTool[] = ["navigate", "click", "submit", "wait", "blocked"];
  const tool = validTools.includes(toolRaw as BrowserTool) ? (toolRaw as BrowserTool) : "blocked";

  const coords = coordsFromParsed(parsed, observation.ocrBlocks);
  if (coords) {
    if (observation.blockedIds.has(coordBlockKey(coords))) {
      return {
        tool: "blocked",
        elementId: null,
        url: null,
        coords: null,
        text: null,
        value: null,
        reasoning: "OCR coordinate already tried.",
        ...emptyActionFields()
      };
    }
    return {
      tool: "click",
      elementId: null,
      url: null,
      coords,
      text: null,
      value: null,
      reasoning: String(parsed.reasoning ?? rankReasoning ?? ""),
      ...emptyActionFields()
    };
  }

  const clickValidIds = rankedIds.length
    ? new Set([...rankedIds, ...observation.fields.map((e) => e.elementId)])
    : new Set([...observation.actions.map((e) => e.elementId), ...observation.fields.map((e) => e.elementId)]);

  const elementIdRaw = parsed.elementId ? String(parsed.elementId) : "";
  let elementId = clickValidIds.has(elementIdRaw) ? elementIdRaw : null;
  if (elementId) {
    const picked = observation.allActions.find((e) => e.elementId === elementId);
    if (observation.blockedIds.has(elementId) || guardFail(picked)) elementId = null;
  }

  const urlRaw = parsed.url ? routerResolveUrl(String(parsed.url), observation.pageUrl) : "";
  let url =
    urlRaw &&
    observation.allowedUrls.has(urlRaw) &&
    isAllowedNavigateUrl(
      urlRaw,
      observation.pageUrl,
      observation.pageHost,
      observation.targetApplyUrl,
      observation.hiddenApplyUrl,
      observation.leftListing
    )
      ? urlRaw
      : null;

  let resolvedTool: BrowserTool =
    tool === "navigate" && !url && elementId
      ? "click"
      : (tool === "click" || tool === "submit") && !elementId && url
        ? "navigate"
        : tool;

  if (rankedIds.length && observation.phase !== "pre_apply") {
    if (resolvedTool !== "click" && resolvedTool !== "submit") {
      resolvedTool = "click";
      elementId = rankedIds[0];
      url = null;
    } else if (!elementId || !rankedIds.includes(elementId)) {
      elementId = rankedIds[0];
      resolvedTool = "click";
      url = null;
    }
  }

  if (resolvedTool === "click" && !elementId && !coords) resolvedTool = "blocked";
  if (resolvedTool === "navigate" && !url) resolvedTool = "blocked";

  return {
    tool: resolvedTool,
    elementId,
    url,
    coords: null,
    text: null,
    value: null,
    reasoning: String(parsed.reasoning ?? rankReasoning ?? ""),
    coverLetterElementIds: [],
    coverLetterRevealIds: [],
    resumeElementIds: []
  };
}

async function resolveOcrApplyClick(
  apiKey: string,
  model: string,
  observation: PageObservation,
  rankReasoning: string
): Promise<BrowserAction | null> {
  if (!observation.ocrBlocks.length) return null;

  const ocrText = formatOcrBlocks(observation.ocrBlocks);
  const compact = compactHistory(observation.history, 3);
  const prompt = [
    observation.phase === "pre_apply"
      ? "Choose the OCR text block to click to start or advance the job application."
      : "Choose the OCR text block to click to advance the current application form step.",
    'Return exactly: {"blockIndex":null,"reasoning":""}',
    "Pick blockIndex from OCR_BLOCKS. The click happens at the center of that box.",
    "Do not reference DOM elements or elementIds.",
    observation.targetTitle
      ? `Target job: "${observation.targetTitle}" at ${observation.targetCompany}`
      : "Target: the job the user chose to apply to",
    `Target URL: ${observation.targetApplyUrl}`,
    `Current page: ${observation.pageUrl}`,
    compact.length ? `Recent actions: ${JSON.stringify(compact)}` : "",
    rankReasoning ? `Prior reasoning: ${rankReasoning}` : "",
    observation.blockedIds.size ? `Skip these (already tried): ${[...observation.blockedIds].join(", ")}` : "",
    `OCR_BLOCKS:\n${ocrText}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouterSingle(apiKey, model, [{ text: prompt }], true);
  const parsed = parseRouterJson(raw);
  const coords = coordsFromParsed(parsed, observation.ocrBlocks);
  if (!coords) return null;
  if (observation.blockedIds.has(coordBlockKey(coords))) return null;

  return {
    tool: "click",
    elementId: null,
    url: null,
    coords,
    text: null,
    value: null,
    reasoning: String(parsed.reasoning ?? ""),
    ...emptyActionFields()
  };
}

async function tryOcrCoordinateClick(
  apiKey: string,
  model: string,
  observation: PageObservation,
  rankReasoning: string,
  rankedIds: string[]
): Promise<BrowserAction | null> {
  const ocrClick = await resolveOcrApplyClick(apiKey, model, observation, rankReasoning);
  if (!ocrClick) return null;
  const validated = validateBrowserAction(observation, ocrClick, rankedIds);
  return validated.tool !== "blocked" ? validated : null;
}

function emptyActionFields(): Pick<BrowserAction, "coverLetterElementIds" | "coverLetterRevealIds" | "resumeElementIds"> {
  return { coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
}

export function validateBrowserAction(
  observation: PageObservation,
  action: BrowserAction,
  rankedIds: string[]
): BrowserAction {
  const guardFail = (picked: PageElement | undefined) =>
    axActionGuardFail(
      picked,
      observation.applyAnchorUrls,
      observation.pageUrl,
      observation.leftListing,
      observation.targetApplyUrl
    );

  if (action.tool === "navigate") {
    const resolved = action.url ? routerResolveUrl(action.url, observation.pageUrl) : "";
    if (
      !resolved ||
      !observation.allowedUrls.has(resolved) ||
      !isAllowedNavigateUrl(
        resolved,
        observation.pageUrl,
        observation.pageHost,
        observation.targetApplyUrl,
        observation.hiddenApplyUrl,
        observation.leftListing
      )
    ) {
      return { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "Navigation target not allowed.", ...emptyActionFields() };
    }
    if (
      observation.phase === "pre_apply" &&
      normalizeApplyScopeUrl(resolved, observation.pageUrl) === normalizeApplyScopeUrl(observation.pageUrl, observation.pageUrl)
    ) {
      return { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "Navigation would not change page.", ...emptyActionFields() };
    }
    return { ...action, url: resolved };
  }

  if (action.tool === "click" || action.tool === "submit") {
    if (action.coords && Number.isFinite(Number(action.coords.x)) && Number.isFinite(Number(action.coords.y))) {
      const x = Math.round(Number(action.coords.x));
      const y = Math.round(Number(action.coords.y));
      if (x < 0 || x > 1000 || y < 0 || y > 1000) {
        return { tool: "blocked", elementId: null, url: null, coords: null, text: null, value: null, reasoning: "OCR coordinates out of range.", ...emptyActionFields() };
      }
      if (observation.blockedIds.has(coordBlockKey({ x, y }))) {
        return { tool: "blocked", elementId: null, url: null, coords: null, text: null, value: null, reasoning: "OCR coordinate already tried.", ...emptyActionFields() };
      }
      return { ...action, elementId: null, coords: { x, y } };
    }
    const elementId = action.elementId ? String(action.elementId) : "";
    if (!elementId) {
      return { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "Click action missing element.", ...emptyActionFields() };
    }
    const picked = observation.allActions.find((e) => e.elementId === elementId);
    if (observation.blockedIds.has(elementId) || guardFail(picked)) {
      return { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "Element blocked or off-target.", ...emptyActionFields() };
    }
    if (rankedIds.length && observation.phase !== "pre_apply" && !rankedIds.includes(elementId)) {
      return { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "Element not in ranked candidates.", ...emptyActionFields() };
    }
    const stemChildUrl = resolveStemChildActionUrl(picked, observation.applyAnchorUrls, observation.pageUrl);
    return { ...action, elementId, url: stemChildUrl || action.url };
  }

  return action;
}

export async function routeBrowserAction(
  apiKey: string,
  cheapModel: string,
  observation: PageObservation,
  semanticMemoryResolve?: (obs: PageObservation, rankedIds: string[]) => Promise<BrowserAction | null>
): Promise<BrowserAction> {
  const candidates = buildDeterministicCandidates(observation);
  let rankedIds = candidates.rankedIds;
  let rankReasoning = "";
  const rankKind = observation.phase === "pre_apply" ? "apply" : "form";

  if (observation.phase === "application_form") {
    const ranked = await rankCandidatesWithCheapModel(apiKey, cheapModel, observation, candidates, rankKind);
    rankedIds = ranked.rankedIds;
    rankReasoning = ranked.reasoning;
  }

  observation.ambiguous = isAmbiguous(rankedIds, candidates.applyAdvancingIds.length);

  if (observation.phase === "pre_apply") {
    const ocrClick = await tryOcrCoordinateClick(apiKey, cheapModel, observation, rankReasoning, rankedIds);
    if (ocrClick) return ocrClick;
    for (const candidate of candidates.navigateUrls) {
      const validated = validateBrowserAction(
        observation,
        {
          tool: "navigate",
          elementId: null,
          url: candidate,
          text: null,
          value: null,
          reasoning: "Navigate to target job apply URL.",
          ...emptyActionFields()
        },
        rankedIds
      );
      if (validated.tool !== "blocked") return validated;
    }
    return {
      tool: "blocked",
      elementId: null,
      url: null,
      text: null,
      value: null,
      reasoning: "No apply-advancing OCR target found.",
      ...emptyActionFields()
    };
  }

  if (semanticMemoryResolve) {
    const memoryAction = await semanticMemoryResolve(observation, rankedIds);
    if (memoryAction) {
      const validated = validateBrowserAction(observation, memoryAction, rankedIds);
      if (validated.tool !== "blocked") return validated;
    }
  }

  const ocrClick = await tryOcrCoordinateClick(apiKey, cheapModel, observation, rankReasoning, rankedIds);
  if (ocrClick) return ocrClick;

  if (observation.ambiguous || observation.stuck) {
    return validateBrowserAction(
      observation,
      await recoverWithStrongModel(apiKey, observation, rankedIds, rankReasoning),
      rankedIds
    );
  }

  if (rankedIds[0]) {
    const validated = validateBrowserAction(
      observation,
      {
        tool: "click",
        elementId: rankedIds[0],
        url: null,
        text: null,
        value: null,
        reasoning: rankReasoning || "Form-advancing control.",
        ...emptyActionFields()
      },
      rankedIds
    );
    if (validated.tool !== "blocked") return validated;
  }

  return validateBrowserAction(
    observation,
    await recoverWithStrongModel(apiKey, observation, rankedIds, rankReasoning),
    rankedIds
  );
}
