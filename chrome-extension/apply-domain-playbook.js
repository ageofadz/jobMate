const SEMANTIC_MEMORY_STORAGE_KEY = "jobmateSemanticSiteMemory";

function semanticMemoryHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function semanticMemoryStateKey(pageUrl, phase, fieldCount) {
  const host = semanticMemoryHost(pageUrl);
  let path = "";
  try {
    path = new URL(pageUrl).pathname;
  } catch {}
  return `${host}|${phase}|f${fieldCount}|${path}`;
}

async function loadSemanticMemory() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  const result = await new Promise((resolve) => {
    chrome.storage.local.get([SEMANTIC_MEMORY_STORAGE_KEY], (stored) => {
      resolve(stored || {});
    });
  });
  return result[SEMANTIC_MEMORY_STORAGE_KEY] || {};
}

async function saveSemanticMemory(memory) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [SEMANTIC_MEMORY_STORAGE_KEY]: memory }, resolve);
  });
}

function observationSummaryForMemory(observation) {
  const fieldSummary = (observation.fields || [])
    .slice(0, 8)
    .map((f) => `${f.label || f.text || ""}(${f.fieldType || f.type || ""})`)
    .join(", ");
  const actionSummary = (observation.actions || [])
    .slice(0, 12)
    .map((a) => `[${a.role || a.tag}] ${a.text || a.name || ""}`)
    .join("\n");
  return {
    pageUrl: observation.pageUrl,
    phase: observation.phase,
    fieldCount: (observation.fields || []).length,
    fieldSummary,
    actionSummary,
    pageText: String(observation.pageText || "").slice(0, 800)
  };
}

async function resolveFromSemanticMemory(apiKey, model, observation, rankedIds) {
  const host = semanticMemoryHost(observation.pageUrl);
  if (!host) return null;

  const memory = await loadSemanticMemory();
  const entries = Object.values(memory).filter((e) => e && e.host === host && e.task === "apply_to_job");
  if (!entries.length) return null;

  const summary = observationSummaryForMemory(observation);
  const candidateLines = (observation.actions || [])
    .filter((a) => !observation.blockedIds.has(a.elementId))
    .filter((a) => !rankedIds.length || rankedIds.includes(a.elementId))
    .slice(0, 40)
    .map((a) => `elementId="${a.elementId}" role=${a.role || a.tag} label="${String(a.text || a.name || "").slice(0, 80)}"`)
    .join("\n");

  const memoryLines = entries
    .slice(0, 20)
    .map((e, i) => `${i}: state="${e.stateDescription}" action="${e.actionDescription}" tool=${e.tool} success=${e.successCount || 0}`)
    .join("\n");

  const prompt = [
    "Match the current page state to one learned site memory entry for a job application task.",
    'Return exactly: {"matchIndex":null,"elementId":null,"tool":null,"reasoning":""}',
    "matchIndex is the numeric index from MEMORY ENTRIES, or null if no match.",
    "elementId must be from CURRENT CANDIDATES when tool is click or submit.",
    "tool must be navigate, click, or submit when matched.",
    `Current page: ${summary.pageUrl}`,
    `Phase: ${summary.phase}`,
    `Fields (${summary.fieldCount}): ${summary.fieldSummary}`,
    summary.actionSummary ? `Visible actions:\n${summary.actionSummary}` : "",
    `MEMORY ENTRIES:\n${memoryLines}`,
    candidateLines ? `CURRENT CANDIDATES:\n${candidateLines}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const matchIndex = parsed.matchIndex === null || parsed.matchIndex === undefined ? null : Number(parsed.matchIndex);
  if (matchIndex === null || !Number.isFinite(matchIndex) || matchIndex < 0 || matchIndex >= entries.length) {
    return null;
  }

  const entry = entries[matchIndex];
  const tool = String(parsed.tool || entry.tool || "");
  if (tool === "navigate" && entry.url) {
    return {
      tool: "navigate",
      elementId: null,
      url: entry.url,
      text: null,
      value: null,
      reasoning: String(parsed.reasoning || entry.actionDescription || "Semantic site memory."),
      fromSemanticMemory: true,
      coverLetterElementIds: [],
      coverLetterRevealIds: [],
      resumeElementIds: []
    };
  }

  if (tool === "click" || tool === "submit") {
    const elementId = parsed.elementId ? String(parsed.elementId) : "";
    if (!elementId) return null;
    if (rankedIds.length && !rankedIds.includes(elementId)) return null;
    if (observation.blockedIds.has(elementId)) return null;
    return {
      tool,
      elementId,
      url: null,
      text: null,
      value: null,
      reasoning: String(parsed.reasoning || entry.actionDescription || "Semantic site memory."),
      fromSemanticMemory: true,
      coverLetterElementIds: [],
      coverLetterRevealIds: [],
      resumeElementIds: []
    };
  }

  return null;
}

async function recordSemanticMemoryStep(apiKey, model, pageUrl, phase, fieldCount, tool, actionElement, navigateUrl, pageText) {
  const host = semanticMemoryHost(pageUrl);
  if (!host) return;

  const stateKey = semanticMemoryStateKey(pageUrl, phase, fieldCount);
  const elementDesc = actionElement
    ? `[${actionElement.role || actionElement.tag}] ${actionElement.text || actionElement.name || ""}`
    : "";
  const prompt = [
    "Describe this job-application page state and the successful action taken, for reuse on similar pages later.",
    'Return exactly: {"stateDescription":"","actionDescription":""}',
    "Descriptions must be semantic and language-neutral. Do not include CSS selectors or exact button text requirements.",
    `Page URL: ${pageUrl}`,
    `Phase: ${phase}`,
    `Field count: ${fieldCount}`,
    `Action tool: ${tool}`,
    navigateUrl ? `Navigate URL: ${navigateUrl}` : "",
    elementDesc ? `Action element: ${elementDesc}` : "",
    pageText ? `Page excerpt:\n${String(pageText).slice(0, 600)}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const stateDescription = String(parsed.stateDescription || "").trim();
  const actionDescription = String(parsed.actionDescription || "").trim();
  if (!stateDescription || !actionDescription) return;

  const memory = await loadSemanticMemory();
  const prev = memory[stateKey];
  memory[stateKey] = {
    host,
    task: "apply_to_job",
    phase,
    fieldCount,
    stateDescription,
    actionDescription,
    tool,
    url: navigateUrl || null,
    successCount: (prev?.successCount || 0) + 1,
    updatedAt: Date.now()
  };
  await saveSemanticMemory(memory);
}

async function lookupPlaybookAction(pageUrl, fieldCount, elements, blockedIds) {
  return null;
}

async function recordPlaybookStep(pageUrl, fieldCount, tool, element, navigateUrl, pageText) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "JOBMATE_RECORD_SEMANTIC_MEMORY",
        pageUrl,
        fieldCount,
        tool,
        element,
        navigateUrl: navigateUrl || null,
        pageText: pageText || ""
      },
      () => resolve()
    );
  });
}
