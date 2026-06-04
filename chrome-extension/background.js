importScripts("jobmate-app-url.js", "apply-navigation.js", "apply-domain-playbook.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const applySessionByTabId = new Map();
const applyAutomationTabByPayload = new Map();
const internalSessionJobData = new Map();
const coverLetterReviewBySession = new Map();
const coverLetterReviewByTab = new Map();

function openCoverLetterReviewSession(draft, openerTabId) {
  const sessionId = crypto.randomUUID();
  return new Promise((resolve) => {
    coverLetterReviewBySession.set(sessionId, {
      draft: String(draft || ""),
      openerTabId: openerTabId ?? null,
      resolve
    });
    const url = chrome.runtime.getURL(`cover-letter-editor.html?id=${encodeURIComponent(sessionId)}`);
    chrome.tabs.create({ url, active: true });
  });
}

// ── Sidebar port ────────────────────────────────────────────────────────────

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== "sidepanel") return;
  sidePanelPort = p;
  p.onDisconnect.addListener(() => { sidePanelPort = null; });
  p.onMessage.addListener((msg) => handleSidePanelMessage(msg));
  pushToSidePanel({ type: "TASKS_SNAPSHOT", tasks: getAllTasksForSidebar() });
});

function pushToSidePanel(msg) {
  if (!sidePanelPort) return;
  try { sidePanelPort.postMessage(msg); } catch { }
}

// ── Task system ─────────────────────────────────────────────────────────────

const tasksById = new Map();

function createTask(title, type, steps = []) {
  const id = crypto.randomUUID();
  const task = {
    id,
    title,
    type,
    status: "pending",
    statusText: "Starting…",
    steps: steps.map((label) => ({ label, status: "pending" })),
    groupId: null,
    createdAt: Date.now()
  };
  tasksById.set(id, task);
  pushToSidePanel({ type: "TASK_UPDATE", task: serializeTask(task) });
  return task;
}

function updateTask(id, patch) {
  const task = tasksById.get(id);
  if (!task) return;
  Object.assign(task, patch);
  pushToSidePanel({ type: "TASK_UPDATE", task: serializeTask(task) });
}

function setTaskStep(taskId, stepLabel, stepStatus) {
  const task = tasksById.get(taskId);
  if (!task) return;
  const step = task.steps.find((s) => s.label === stepLabel);
  if (step) step.status = stepStatus;
  pushToSidePanel({ type: "TASK_UPDATE", task: serializeTask(task) });
}

function serializeTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusText: task.statusText,
    steps: task.steps.map((s) => ({ label: s.label, status: s.status })),
    groupId: task.groupId
  };
}

function getAllTasksForSidebar() {
  return [...tasksById.values()].map(serializeTask);
}

// ── Tab groups ───────────────────────────────────────────────────────────────

async function createTaskTabGroup(title, color = "blue") {
  const dummy = await chrome.tabs.create({ url: "about:blank", active: false });
  const groupId = await chrome.tabs.group({ tabIds: [dummy.id] });
  await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
  await chrome.tabs.remove(dummy.id);
  return groupId;
}

async function addTabToGroup(tabId, groupId) {
  await chrome.tabs.group({ tabIds: [tabId], groupId }).catch(() => { });
}

async function openTabInGroup(url, groupId, active = false) {
  const tab = await chrome.tabs.create({ url, active });
  if (groupId != null) {
    await addTabToGroup(tab.id, groupId).catch(() => { });
  }
  return tab;
}

// ── Sidebar message handler ─────────────────────────────────────────────────

function handleSidePanelMessage(msg) {
  if (!msg?.type) return;

  if (msg.type === "SIDEPANEL_READY") {
    pushToSidePanel({ type: "TASKS_SNAPSHOT", tasks: getAllTasksForSidebar() });
    return;
  }

  if (msg.type === "TASK_SUBMIT") {
    handleTaskSubmit(String(msg.text || "").trim());
    return;
  }

  if (msg.type === "TASK_DISMISS") {
    const taskId = String(msg.taskId || "");
    tasksById.delete(taskId);
    pushToSidePanel({ type: "TASK_REMOVED", taskId });
    return;
  }

  if (msg.type === "CLARIFY_REPLY") {
    const resolver = pendingClarifyResolvers.get(msg.clarifyId);
    if (resolver) {
      pendingClarifyResolvers.delete(msg.clarifyId);
      resolver(String(msg.reply || ""));
    }
    return;
  }

  if (msg.type === "CALLOUT_REPLY") {
    const resolver = pendingCalloutResolvers.get(msg.taskId);
    if (resolver) {
      pendingCalloutResolvers.delete(msg.taskId);
      resolver(msg.reply ?? null);
    }
    return;
  }
}

// ── Clarify / callout awaitable helpers ──────────────────────────────────────

const pendingClarifyResolvers = new Map();
const pendingCalloutResolvers = new Map();

function askClarify(question) {
  const clarifyId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingClarifyResolvers.set(clarifyId, resolve);
    pushToSidePanel({ type: "CLARIFY_REQUEST", clarifyId, question });
  });
}

function requestCallout(taskId, msg) {
  return new Promise((resolve) => {
    pendingCalloutResolvers.set(taskId, resolve);
    pushToSidePanel({ type: "CALLOUT", taskId, ...msg });
  });
}

// ── Site tool memory ─────────────────────────────────────────────────────────

function siteToolKey(hostname) {
  return `siteTool:${hostname.replace(/^www\./, "")}`;
}

async function getSiteTool(hostname) {
  const key = siteToolKey(hostname);
  const result = await new Promise((resolve) => chrome.storage.local.get([key], resolve));
  return result[key] ?? null;
}

async function saveSiteTool(hostname, tool) {
  const key = siteToolKey(hostname);
  await new Promise((resolve) => chrome.storage.local.set({ [key]: tool }, resolve));
}

async function recordSiteToolStep(hostname, step) {
  const existing = await getSiteTool(hostname) ?? { hostname, steps: [], successCount: 0, failCount: 0, updatedAt: 0 };
  existing.steps.push(step);
  existing.updatedAt = Date.now();
  await saveSiteTool(hostname, existing);
}

async function markSiteToolSuccess(hostname) {
  const existing = await getSiteTool(hostname);
  if (!existing) return;
  existing.successCount = (existing.successCount || 0) + 1;
  existing.lastUsed = Date.now();
  await saveSiteTool(hostname, existing);
}

async function markSiteToolFailed(hostname) {
  const existing = await getSiteTool(hostname);
  if (!existing) return;
  existing.failCount = (existing.failCount || 0) + 1;
  if (existing.failCount > 2 && existing.failCount > existing.successCount) {
    existing.steps = [];
  }
  await saveSiteTool(hostname, existing);
}

// ── LLM task planner ─────────────────────────────────────────────────────────

async function planTask(userText, cfg) {
  const apiKey = cfg.geminiApiKey?.trim();
  if (!apiKey) return null;

  const contextSnippet = (cfg.contextBlock || "").slice(0, 1200);
  const prompt = [
    "You are an agentic browser assistant planner.",
    "Given a user task, return a short JSON plan.",
    "Shape: {\"title\":\"...\",\"needsClarify\":false,\"clarifyQuestion\":\"\",\"steps\":[{\"label\":\"...\",\"type\":\"navigate|search|fill|click|email|read\",\"detail\":\"...\"}]}",
    "title: short task title (max 60 chars).",
    "needsClarify: true only if the task is critically ambiguous and one quick question would resolve it.",
    "clarifyQuestion: the single most important clarifying question if needsClarify is true, otherwise empty string.",
    "steps: 2 to 6 concrete steps. Each step has a label (short, shown in UI) and detail (instructions for the agent).",
    "Do not ask for information that is already in the candidate context.",
    "Return valid JSON only.",
    contextSnippet ? `Candidate context:\n${contextSnippet}` : "",
    `User task: ${userText}`
  ].filter(Boolean).join("\n\n");

  try {
    const raw = await callGeminiExt([{ text: prompt }], apiKey, cfg.geminiModel?.trim() || GEMINI_FALLBACK_MODELS[0], true);
    const parsed = parseJsonObjectExt(raw);
    return parsed;
  } catch {
    return { title: userText.slice(0, 60), needsClarify: false, clarifyQuestion: "", steps: [{ label: "Run task", type: "navigate", detail: userText }] };
  }
}

// ── Task submission entry point ───────────────────────────────────────────────

async function handleTaskSubmit(text) {
  if (!text) return;

  const cfg = await getExtensionConfig();

  if (!cfg.geminiApiKey?.trim()) {
    pushToSidePanel({
      type: "CALLOUT",
      taskId: "cfg",
      kind: "warn",
      label: "Setup required",
      message: "Add your Gemini API key in Settings before running tasks.",
      instruction: "",
      hasInput: false,
      buttonLabel: "OK"
    });
    pendingCalloutResolvers.set("cfg", () => { });
    return;
  }

  const plan = await planTask(text, cfg);
  if (!plan) return;

  let resolvedText = text;

  if (plan.needsClarify && plan.clarifyQuestion) {
    const answer = await askClarify(plan.clarifyQuestion);
    resolvedText = `${text}\n\nAdditional context: ${answer}`;
    const revisedPlan = await planTask(resolvedText, cfg);
    if (revisedPlan) Object.assign(plan, revisedPlan);
  }

  const stepLabels = (plan.steps || []).map((s) => s.label);
  const task = createTask(plan.title || text.slice(0, 60), "general", stepLabels);

  const color = detectTaskColor(plan.steps || []);
  const groupTitle = (plan.title || text).slice(0, 40);
  const groupId = await createTaskTabGroup(groupTitle, color).catch(() => null);
  updateTask(task.id, { groupId, status: "running", statusText: "Running…" });

  runTaskPlan(task, plan.steps || [], cfg, groupId, resolvedText).catch((err) => {
    updateTask(task.id, { status: "error", statusText: String(err?.message || err) });
  });
}

function detectTaskColor(steps) {
  const types = steps.map((s) => s.type);
  if (types.includes("email")) return "yellow";
  if (types.includes("search")) return "blue";
  if (types.includes("fill")) return "green";
  return "cyan";
}

async function runTaskPlan(task, steps, cfg, groupId, originalText) {
  for (const step of steps) {
    setTaskStep(task.id, step.label, "active");
    updateTask(task.id, { statusText: step.label });

    try {
      await executeStep(task, step, cfg, groupId);
      setTaskStep(task.id, step.label, "done");
    } catch (err) {
      setTaskStep(task.id, step.label, "error");
      updateTask(task.id, { status: "waiting", statusText: `Stuck: ${err.message}` });

      const reply = await requestCallout(task.id, {
        kind: "warn",
        label: "Needs help",
        message: `Stuck on: ${step.label}`,
        instruction: err.message,
        hasInput: true,
        inputPlaceholder: "Describe how to continue, or leave blank to skip…",
        buttonLabel: "Continue"
      });

      updateTask(task.id, { status: "running", statusText: "Continuing…" });
      if (reply) {
        try {
          await executeStep(task, { ...step, detail: reply }, cfg, groupId);
          setTaskStep(task.id, step.label, "done");
        } catch { }
      }
    }
  }

  updateTask(task.id, { status: "done", statusText: "Done." });
  pushToSidePanel({ type: "CALLOUT_CLEAR" });
}

async function executeStep(task, step, cfg, groupId) {
  const type = step.type || "navigate";

  if (type === "search") {
    await executeSearchStep(task, step, cfg, groupId);
    return;
  }

  if (type === "fill" || type === "navigate") {
    await executeApplyStep(task, step, cfg, groupId);
    return;
  }

  if (type === "email") {
    await executeEmailStep(task, step, cfg, groupId);
    return;
  }

  await executeApplyStep(task, step, cfg, groupId);
}

async function executeSearchStep(task, step, cfg, groupId) {
  const query = step.detail || step.label;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const tab = await openTabInGroup(searchUrl, groupId, false);
  await waitTabComplete(tab.id, 30000).catch(() => { });
}

async function executeApplyStep(task, step, cfg, groupId) {
  const url = extractUrl(step.detail) || extractUrl(step.label);
  if (!url) return;

  const sessionId = crypto.randomUUID();
  const sessionKey = `ext://session/${sessionId}`;
  internalSessionJobData.set(sessionKey, {
    applyUrl: url, title: task.title, company: "", listingText: step.detail || "",
    jobId: task.id, linkedinLinks: [], hiringContacts: [], coverLetterText: ""
  });

  const u = new URL(url);
  u.hash = `jobmateSession=${encodeURIComponent(sessionId)}`;

  const tab = await openTabInGroup(u.toString(), groupId, false);
  applyAutomationTabByPayload.set(sessionKey, tab.id);
  setApplySession(tab.id, sessionKey, null);
}

async function executeEmailStep(task, step, cfg, groupId) {
  const tab = await openTabInGroup("https://mail.google.com/mail/u/0/#inbox", groupId, true);
  await waitTabComplete(tab.id, 30000).catch(() => { });
  await requestCallout(task.id, {
    kind: "info",
    label: "Email",
    message: "Gmail is open in the tab group. Complete the email task, then click Continue.",
    instruction: step.detail || "",
    hasInput: false,
    buttonLabel: "Continue"
  });
}

function extractUrl(text) {
  if (!text) return null;
  try {
    const match = text.match(/https?:\/\/[^\s"']+/);
    return match ? new URL(match[0]).toString() : null;
  } catch {
    return null;
  }
}

const GEMINI_FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-2-flash", "gemini-3.1-flash-lite"];
const AGENT_GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2-flash"];
const FORM_CHUNK_SIZE = 20;

function resolveAgentModel(config) {
  const user = config.geminiModel?.trim();
  if (user && !/lite/i.test(user)) return user;
  return AGENT_GEMINI_MODELS[0];
}

async function captureTabScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.windowId) throw new Error("Tab has no window.");
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(200);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 72 });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const A11Y_INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox",
  "radio", "checkbox", "switch", "menuitem", "tab", "spinbutton", "slider",
  "menuitemcheckbox", "menuitemradio", "option"
]);

async function getA11ySnapshot(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch {
    return null;
  }
  try {
    const { nodes } = await chrome.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree");
    const lines = [];
    let n = 0;
    for (const node of nodes) {
      const role = node.role?.value;
      if (!role || !A11Y_INTERACTIVE_ROLES.has(role)) continue;
      const name = (node.name?.value || "").trim().slice(0, 80);
      if (!name) continue;
      const props = node.properties || [];
      const disabled = props.find((p) => p.name === "disabled")?.value?.value === true;
      if (disabled) continue;
      const required = props.find((p) => p.name === "required")?.value?.value === true;
      const checked = props.find((p) => p.name === "checked")?.value?.value;
      const value = props.find((p) => p.name === "value")?.value?.value;
      let line = `[${role}] "${name}"`;
      if (required) line += " required";
      if (checked !== undefined && checked !== "mixed") line += ` checked:${checked}`;
      if (value && (role === "textbox" || role === "searchbox") && String(value).trim()) {
        line += ` value:"${String(value).slice(0, 40)}"`;
      }
      lines.push(line);
      if (++n >= 80) break;
    }
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  } finally {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function chunkFields(fields, size = FORM_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < fields.length; i += size) {
    chunks.push(fields.slice(i, i + size));
  }
  return chunks;
}

function formChunkKind(fields) {
  if (fields.every((f) => f.type === "file")) return "file";
  if (fields.some((f) => f.type === "textarea" || f.type === "contenteditable")) return "longform";
  const labels = fields.map((f) => (f.label || "").toLowerCase()).join(" ");
  if (/full name|first name|last name|email|phone|linkedin|github|portfolio|website/.test(labels)) return "identity";
  if (fields.some((f) => f.type === "select" || f.type === "radio" || f.type === "checkbox")) return "choice";
  return "screening";
}

const COMPENSATION_PROMPT_LINES = [
  "For desired salary, compensation expectation, salary range, pay, rate, or minimum compensation fields, analyze the listing's posted compensation and the candidate's preferred compensation range from the candidate context.",
  "If the listing includes compensation, answer with a concise value or range inside the overlap between the posted range and the candidate's preferred range.",
  "If there is overlap and the candidate is a strong fit, lean toward the upper half of that overlap.",
  "If the listing does not include compensation, answer from the candidate's preferred compensation range.",
  "Do not leave required compensation fields empty when the candidate context contains a preferred compensation range."
];

function parseJsonObjectExt(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty LLM output.");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try { return JSON.parse(candidate); } catch { }
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("LLM output did not contain a JSON object.");
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)); }
  }
  throw new Error("LLM output did not contain a complete JSON object.");
}

const EXTENSION_CONFIG_STORAGE_KEYS = [
  "geminiApiKey",
  "geminiModel",
  "candidateName",
  "candidateEmail",
  "contextBlock",
  "writingSample",
  "coverLetterTemplate",
  "resumePdfBase64",
  "resumePdfFilename",
  "resumePdfMimeType"
];

function getExtensionConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(EXTENSION_CONFIG_STORAGE_KEYS, resolve);
  });
}

function applyExtensionConfigFromApp(config) {
  if (!config || typeof config !== "object") {
    return Promise.resolve(false);
  }
  const updates = {};
  for (const key of EXTENSION_CONFIG_STORAGE_KEYS) {
    const value = config[key];
    if (typeof value === "string") {
      updates[key] = value;
    }
  }
  return new Promise((resolve) => {
    chrome.storage.local.set(updates, () => resolve(true));
  });
}

async function fetchAppConfigFromTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "JOBMATE_FETCH_APP_CONFIG" });
}

async function shouldSyncConfigFromApp() {
  const stored = await new Promise((resolve) => chrome.storage.local.get(["needsConfigFromApp"], resolve));
  if (stored.needsConfigFromApp) {
    return true;
  }
  const cfg = await getExtensionConfig();
  return !String(cfg.geminiApiKey ?? "").trim();
}

async function syncExtensionConfigFromTab(tabId) {
  const resp = await fetchAppConfigFromTab(tabId);
  if (!resp?.ok || !resp.config) {
    return false;
  }
  await applyExtensionConfigFromApp(resp.config);
  await new Promise((resolve) => chrome.storage.local.set({ needsConfigFromApp: false }, resolve));
  return true;
}

async function syncExtensionConfigFromJobMateApp() {
  if (!(await shouldSyncConfigFromApp())) {
    return false;
  }

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isJobMateAppUrl(tab.url)) {
      continue;
    }
    try {
      if (await syncExtensionConfigFromTab(tab.id)) {
        return true;
      }
    } catch { }
  }

  return false;
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }
  chrome.storage.local.set({ needsConfigFromApp: true }, () => {
    void syncExtensionConfigFromJobMateApp();
  });
});

async function callGeminiExt(parts, apiKey, primaryModel, json = false) {
  const models = [...new Set([primaryModel || GEMINI_FALLBACK_MODELS[0], ...GEMINI_FALLBACK_MODELS])];
  let lastError = "";
  for (const model of models) {
    let res = null;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
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
    } catch (err) { lastError = String(err.message || err); continue; }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      lastError = `${model}: ${res.status}${txt ? " " + txt.slice(0, 300) : ""}`;
      continue;
    }
    const payload = await res.json();
    const text = payload.candidates?.flatMap((c) => c.content?.parts ?? []).map((p) => p.text ?? "").join("") ?? "";
    if (text.trim()) return text;
    lastError = `${model}: empty response`;
  }
  throw new Error(`Gemini request failed. ${lastError}`);
}

function getSessionJobData(tabId) {
  const session = getApplySession(tabId);
  const payloadUrl = session?.payloadUrl ?? "";
  return payloadUrl ? (internalSessionJobData.get(payloadUrl) ?? {}) : {};
}

async function generateCoverLetterExt(config, jobData, pageLanguage) {
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) return "";
  const model = config.geminiModel?.trim() || GEMINI_FALLBACK_MODELS[0];
  const lang = pageLanguage?.trim().toLowerCase() || "en";
  const hasPdf = Boolean(config.resumePdfBase64);
  const prompt = [
    "Write a short application note for this job. This is not a formal cover letter.",
    "Goal: sound like a real person briefly explaining why this role makes sense for them.",
    "Reference specifics from the listing if possible. Be specific, direct, and slightly understated.",
    "Hard constraints: 2 to 3 short paragraphs only. 120 to 220 words total. No bullets. Plain text only.",
    lang && lang !== "en" ? `Write the entire note in the language with BCP-47 code: ${lang}. Do not use English unless that code is en.` : "Write the entire note in English.",
    "Address it to the hiring team unless a specific contact is provided.",
    "Use plain ASCII punctuation only. No em dashes, en dashes, curly quotes, bullets, or special symbols.",
    "Do not invent employers, degrees, dates, metrics, locations, titles, clients, or domain experience.",
    "Use the candidate writing sample as the style reference.",
    "Prefer simple, concrete sentences. Avoid polished corporate language.",
    "Do not use: 'I am excited to apply', 'I am confident I can contribute', 'leverage my background', 'passionate about', 'perfect fit', 'unique opportunity', 'I look forward to'.",
    "Start with the actual reason the role is interesting, based on the job listing.",
    "Connect 1 or 2 specific pieces of the candidate's real experience to the role.",
    "Mention the company name at most once. Mention the role title at most once.",
    jobData.listingText ? `Job listing:\n${jobData.listingText.slice(0, 8000)}` : "",
    config.contextBlock ? `Candidate context:\n${config.contextBlock}` : "",
    !hasPdf && config.writingSample ? `Candidate writing sample:\n${config.writingSample}` : "",
    config.coverLetterTemplate ? `Template to follow:\n${config.coverLetterTemplate}` : ""
  ].filter(Boolean).join("\n\n");
  const parts = [{ text: prompt }];
  if (hasPdf && config.resumePdfBase64) {
    parts.push({ inline_data: { mime_type: config.resumePdfMimeType || "application/pdf", data: config.resumePdfBase64 } });
  }
  try {
    const raw = await callGeminiExt(parts, apiKey, model, false);
    return raw.replace(/\r\n?/g, "\n").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  } catch { return ""; }
}

function buildFormAnswerPrompt(fields, ctx) {
  const { hasPdf, coverLetterText, contextBlock, writingSample, listingText, retryNote, chunkIndex, chunkTotal, kind } = ctx;
  const requiredFieldSummary = fields
    .filter((f) => f.required)
    .map((f) => `fieldId="${f.fieldId}" label="${f.label}" type=${f.type}${f.options?.length ? ` options=${JSON.stringify(f.options.slice(0, 8))}` : ""}`)
    .join("\n");

  const kindLines = {
    identity: [
      "This chunk is identity/contact info. Use exact candidate name, email, phone, and profile URLs from context.",
      `Candidate name: ${ctx.candidateName || ""}`,
      `Candidate email: ${ctx.candidateEmail || ""}`
    ],
    choice: [
      "This chunk is mostly dropdowns, radios, or checkboxes.",
      "Every answer MUST be the exact text of one listed option. Never invent options or use free text."
    ],
    longform: [
      "This chunk includes long text fields.",
      "Use the cover letter text for cover letter, motivation, or why-us questions.",
      "For other textarea fields, answer concisely unless the label asks for a long statement."
    ],
    file: [
      "This chunk is file uploads only.",
      "Resume/CV fields: return exactly \"__resume__\". Cover letter file fields: return exactly \"__cover_letter__\". Other file fields: empty string."
    ],
    screening: [
      "This chunk is screening questions. Answer from candidate context and job listing.",
      "Be concise and truthful. Match each answer to the exact field label."
    ]
  };

  return [
    "You are filling a job application form.",
    "Each field has a unique fieldId, label, type, and options where applicable. Match answers using the fieldId.",
    chunkTotal > 1 ? `This is chunk ${chunkIndex + 1} of ${chunkTotal}. Answer ONLY the fields in Fields JSON.` : "",
    "Each field has a fieldId. Return answers keyed by the same fieldId.",
    "Read every field label literally. Do not move an answer from one field to another.",
    "You must return exactly one answers item for every field in Fields JSON.",
    "Every field in Fields JSON must have a non-empty answer. No exceptions — optional fields included.",
    "Any field with required=true MUST have a non-empty answer.",
    "Never skip any field. Location, visa sponsorship, work authorization, and how-you-heard must always be answered.",
    hasPdf
      ? "Use the candidate context and attached resume PDF to answer every field."
      : "Use the candidate context to answer every field.",
    ...(kindLines[kind] || kindLines.screening),
    "DROPDOWN AND SELECT RULE: return the exact text of one listed option.",
    "RADIO RULE: return the exact text of one listed option.",
    "If a field asks about visa sponsorship or work authorization, answer from candidate context with the closest matching option.",
    "If a field asks for location, city, state, country, or address, answer from candidate context. Under 80 characters.",
    "If a field asks how the candidate heard about the job, answer exactly 'Google'.",
    `Candidate email: ${ctx.candidateEmail || ""}`,
    "For phone country code, dialing code, indicatif, or Ländervorwahl dropdowns: match the candidate's phone number and stated location in candidate context (+1 → United States / États-Unis / USA, +44 → United Kingdom, +33 → France). Do not guess from unrelated words in context. Do not select Armenia unless the profile phone or location explicitly indicates Armenia (+374).",
    "Never return a filename, file path, or PDF name as an answer.",
    "For file-type fields: read the label. CV/resume/curriculum upload → \"__resume__\" only. Cover letter / motivation letter upload → \"__cover_letter__\" only. Never use __cover_letter__ on a CV field. Never use __resume__ on a cover letter field. Other file fields: empty string.",
    "If a field asks for a URL, answer only a URL from candidate context.",
    "For optional demographic EEO fields, choose the opt-out option when one exists.",
    "For required demographic EEO fields, choose decline/prefer-not-to-say when available.",
    "For non-demographic checkboxes, use the affirmative option label, usually 'Yes'.",
    "For required privacy, terms, data protection, or consent radio/checkbox groups, return the exact accept/agree option label from that field's options list (must match one option character-for-character).",
    ...COMPENSATION_PROMPT_LINES,
    "Return valid JSON only: {\"answers\":[{\"fieldId\":\"\",\"answer\":\"\",\"reasoning\":\"\"}]}",
    requiredFieldSummary ? `REQUIRED FIELDS:\n${requiredFieldSummary}` : "",
    retryNote ? `CRITICAL RETRY:\n${retryNote}` : "",
    `Fields JSON:\n${JSON.stringify(fields)}`,
    contextBlock ? `Candidate context:\n${contextBlock}` : "",
    coverLetterText ? `Cover letter text:\n${coverLetterText}` : "",
    writingSample ? `Candidate writing sample:\n${writingSample.slice(0, 6000)}` : "",
    listingText ? `Job listing text:\n${listingText.slice(0, 8000)}` : ""
  ].filter(Boolean).join("\n\n");
}

async function requestFormAnswersFromGemini(fields, ctx) {
  const { config, apiKey, model } = ctx;
  const hasPdf = Boolean(config.resumePdfBase64);
  const prompt = buildFormAnswerPrompt(fields, ctx);
  const parts = [{ text: prompt }];
  if (hasPdf && config.resumePdfBase64) {
    parts.push({ inline_data: { mime_type: config.resumePdfMimeType || "application/pdf", data: config.resumePdfBase64 } });
  }

  let raw;
  try {
    raw = await callGeminiExt(parts, apiKey, model, true);
  } catch (callErr) {
    throw new Error(`Gemini call failed: ${callErr.message}`);
  }

  let parsed;
  try {
    parsed = parseJsonObjectExt(raw);
  } catch {
    const rawSnippet = raw.slice(0, 600);
    const selfCorrectPrompt = [
      "Return valid JSON only: {\"answers\":[{\"fieldId\":\"\",\"answer\":\"\",\"reasoning\":\"\"}]}",
      `Broken output:\n${rawSnippet}`,
      `Fields:\n${JSON.stringify(fields)}`
    ].join("\n\n");
    const correctedRaw = await callGeminiExt([{ text: selfCorrectPrompt }], apiKey, model, true);
    parsed = parseJsonObjectExt(correctedRaw);
  }

  const validFieldIds = new Set(fields.map((f) => f.fieldId));
  const resumeFieldIds = [];
  const coverLetterFieldIds = [];
  const answers = [];

  for (const item of parsed.answers ?? []) {
    const fieldId = String(item.fieldId ?? "");
    if (!validFieldIds.has(fieldId)) continue;
    const answer = String(item.answer ?? "");
    if (answer === "__resume__") {
      resumeFieldIds.push(fieldId);
      answers.push({ fieldId, answer: "", reasoning: item.reasoning ?? "" });
    } else if (answer === "__cover_letter__") {
      coverLetterFieldIds.push(fieldId);
      answers.push({ fieldId, answer: "", reasoning: item.reasoning ?? "" });
    } else {
      answers.push({ fieldId, answer, reasoning: item.reasoning ?? "" });
    }
  }

  for (const field of fields) {
    if (answers.some((item) => item.fieldId === field.fieldId)) continue;
    answers.push({ fieldId: field.fieldId, answer: "", reasoning: "" });
  }

  return { answers, resumeFieldIds, coverLetterFieldIds };
}

async function classifyFileUploadFieldsExt(apiKey, model, fileFields, contextBlock) {
  if (!fileFields.length) return { resumeFieldIds: [], coverLetterFieldIds: [] };
  const valid = new Set(fileFields.map((f) => f.fieldId));
  const prompt = [
    "Classify file upload fields only. Read each label in any language.",
    "Fields for CV, resume, curriculum vitae, or equivalent → resumeFieldIds.",
    "Fields for cover letter, motivation letter, lettre de motivation, or equivalent → coverLetterFieldIds.",
    "Any other file field belongs in neither list.",
    "The same fieldId must never appear in both arrays.",
    "A CV upload field must never be in coverLetterFieldIds.",
    "A cover letter upload field must never be in resumeFieldIds.",
    "Return JSON only: {\"resumeFieldIds\":[],\"coverLetterFieldIds\":[]}",
    `File fields:\n${JSON.stringify(fileFields.map((f) => ({ fieldId: f.fieldId, label: f.label })))}`,
    contextBlock ? `Candidate context:\n${contextBlock.slice(0, 2000)}` : ""
  ].filter(Boolean).join("\n\n");
  const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);
  const resumeFieldIds = (parsed.resumeFieldIds ?? []).map(String).filter((id) => valid.has(id));
  const coverLetterFieldIds = (parsed.coverLetterFieldIds ?? []).map(String).filter((id) => valid.has(id));
  const coverSet = new Set(coverLetterFieldIds);
  for (const id of resumeFieldIds) {
    if (coverSet.has(id)) {
      throw new Error("A file field was classified as both CV and cover letter.");
    }
  }
  return { resumeFieldIds, coverLetterFieldIds };
}

async function generateFormAnswersExt(tabId, fields, retryNote, pageLanguage) {
  if (!fields.length) return { ok: true, answers: [], resumeFieldIds: [], coverLetterText: "", coverUpload: null };
  const config = await getExtensionConfig();
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) throw new Error("No Gemini API key configured. Open the extension popup → Settings and add your key.");
  const model = resolveAgentModel(config);
  const session = getApplySession(tabId);
  const payloadUrl = session?.payloadUrl ?? "";
  const jobData = payloadUrl ? (internalSessionJobData.get(payloadUrl) ?? {}) : {};
  const contextBlock = config.contextBlock || "";
  const writingSample = config.writingSample || "";
  const listingText = jobData.listingText || "";
  let coverLetterText = jobData.coverLetterText || "";

  const sharedCtx = {
    config,
    apiKey,
    model,
    hasPdf: Boolean(config.resumePdfBase64),
    coverLetterText,
    contextBlock,
    writingSample,
    listingText,
    retryNote: retryNote || "",
    candidateName: config.candidateName?.trim() || "",
    candidateEmail: config.candidateEmail?.trim() || ""
  };

  const chunks = retryNote ? chunkFields(fields) : [fields];
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      requestFormAnswersFromGemini(chunk, {
        ...sharedCtx,
        kind: formChunkKind(chunk),
        chunkIndex: i,
        chunkTotal: chunks.length
      })
    )
  );
  const mergedAnswers = results.flatMap((r) => r.answers);
  let resumeFieldIds = [...new Set(results.flatMap((r) => r.resumeFieldIds))];
  let coverLetterFieldIds = [...new Set(results.flatMap((r) => r.coverLetterFieldIds))];

  const fileFields = fields.filter((f) => f.type === "file");
  if (fileFields.length) {
    const classified = await classifyFileUploadFieldsExt(apiKey, model, fileFields, contextBlock);
    resumeFieldIds = classified.resumeFieldIds;
    coverLetterFieldIds = classified.coverLetterFieldIds;
    const resumeSet = new Set(resumeFieldIds);
    const coverSet = new Set(coverLetterFieldIds);
    for (const entry of mergedAnswers) {
      if (!fileFields.some((f) => f.fieldId === entry.fieldId)) continue;
      if (resumeSet.has(entry.fieldId)) entry.answer = "";
      else if (coverSet.has(entry.fieldId)) entry.answer = "";
      else entry.answer = "";
    }
  }

  return { ok: true, answers: mergedAnswers, resumeFieldIds, coverLetterFieldIds, coverLetterText, coverUpload: null };
}

async function validatePageAdvanceExt(tabId, msg) {
  const config = await getExtensionConfig();
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) throw new Error("No Gemini API key configured.");
  const model = resolveAgentModel(config);

  const goal = String(msg.goal || "Advance the job application form to the next step.");
  const pageUrl = String(msg.pageUrl || "");
  const validationErrors = Array.isArray(msg.validationErrors) ? msg.validationErrors : [];
  const fields = Array.isArray(msg.fields) ? msg.fields : [];

  const fieldSummary = fields
    .slice(0, 24)
    .map((f) => `fieldId="${f.fieldId}" label="${f.label}" type=${f.type} required=${Boolean(f.required)} value=${JSON.stringify(f.value || "")}${f.options?.length ? ` options=${JSON.stringify(f.options.slice(0, 6))}` : ""}`)
    .join("\n");

  const prompt = [
    "You validate whether a job application form step succeeded after the user clicked Continue or Next.",
    `Goal: ${goal}`,
    `Page URL: ${pageUrl}`,
    validationErrors.length
      ? `Validation errors visible on the page:\n${validationErrors.join("\n")}`
      : "No explicit validation errors were detected, but the page did not advance.",
    fieldSummary ? `Current field states:\n${fieldSummary}` : "",
    "Determine whether the form successfully advanced to a new step, or is still blocked on the same step.",
    "If blocked, identify which fields need corrected answers.",
    "Return JSON only: {\"advanced\":true|false,\"corrections\":[{\"fieldId\":\"\",\"answer\":\"\"}],\"reasoning\":\"\"}",
    "corrections must use exact option labels for select/radio/checkbox fields.",
    "If advanced is true, corrections must be an empty array."
  ].filter(Boolean).join("\n\n");

  const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);
  const validFieldIds = new Set(fields.map((f) => f.fieldId));
  const corrections = (parsed.corrections ?? [])
    .map((item) => ({
      fieldId: String(item.fieldId ?? ""),
      answer: String(item.answer ?? "")
    }))
    .filter((item) => item.fieldId && validFieldIds.has(item.fieldId) && item.answer.trim());

  return {
    ok: true,
    advanced: Boolean(parsed.advanced),
    corrections,
    reasoning: String(parsed.reasoning ?? "")
  };
}

const applyPageUrlOscillationByTab = new Map();

function normalizeApplyPageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}${parsed.search}`;
  } catch {
    return String(url || "").trim();
  }
}

function recordApplyPageUrlOscillation(tabId, pageUrl) {
  const u = normalizeApplyPageUrl(pageUrl);
  if (!u) return false;
  let track = applyPageUrlOscillationByTab.get(tabId);
  if (!track) {
    track = { a: null, b: null, last: null, switches: 0 };
    applyPageUrlOscillationByTab.set(tabId, track);
  }
  if (u === track.last) return track.switches >= 2;
  if (!track.a) {
    track.a = u;
    track.last = u;
    return false;
  }
  if (!track.b && u !== track.a) {
    track.b = u;
    track.last = u;
    track.switches = 1;
    return false;
  }
  if (u === track.a || u === track.b) {
    track.switches += 1;
    track.last = u;
    return track.switches >= 2;
  }
  return false;
}

async function nextBrowserActionExt(tabId, pageData) {
  const config = await getExtensionConfig();
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) throw new Error("No Gemini API key configured.");
  const model = resolveAgentModel(config);
  const jobData = getSessionJobData(tabId);

  const { pageUrl, pageText, stepIndex, history, hiddenApplyUrl, elements, blockedElementIds, overlayMap } = pageData;
  const blockedIds = new Set(Array.isArray(blockedElementIds) ? blockedElementIds.map(String) : []);

  if (recordApplyPageUrlOscillation(tabId, pageUrl)) {
    return {
      ok: true,
      action: {
        tool: "blocked",
        elementId: null,
        url: null,
        text: null,
        value: null,
        reasoning:
          "Stopped: the browser kept switching between the same two pages. Open the application page directly, then click Continue.",
        coverLetterElementIds: [],
        coverLetterRevealIds: [],
        resumeElementIds: []
      }
    };
  }
  const targetApplyUrl = jobData.applyUrl || pageUrl;
  const targetTitle = jobData.title || "";
  const targetCompany = jobData.company || "";
  const candidateEmail = config.candidateEmail?.trim() || "";

  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  })();

  if (pageHost === "workatastartup.com") {
    try {
      if (isWorkAtAStartupApplicantPortalPath(new URL(pageUrl).pathname)) {
        return {
          ok: true,
          action: {
            tool: "blocked",
            elementId: null,
            url: null,
            text: null,
            value: null,
            reasoning:
              "Blocked: Work at a Startup account/profile page (/application/*). Go back to the job listing (/jobs/…), then click Continue.",
            coverLetterElementIds: [],
            coverLetterRevealIds: [],
            resumeElementIds: []
          }
        };
      }
    } catch { }
  }

  const allActions = (elements || []).filter((e) => e.type === "action");
  const actions = allActions.filter((e) => !blockedIds.has(e.elementId));
  const fields = (elements || []).filter((e) => e.type === "field");
  const validElementIds = new Set([...allActions.map((e) => e.elementId), ...fields.map((e) => e.elementId)]);

  function resolveUrl(url, base) { try { return new URL(url, base).toString(); } catch { return ""; } }

  const allowedUrls = new Set();
  for (const candidate of [targetApplyUrl, hiddenApplyUrl]) {
    if (!candidate) continue;
    const resolved = resolveUrl(candidate, pageUrl);
    if (resolved && isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl)) {
      allowedUrls.add(resolved);
    }
  }
  for (const a of allActions) {
    if (!a.href) continue;
    const resolved = resolveUrl(a.href, pageUrl);
    if (resolved && isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl)) {
      allowedUrls.add(resolved);
    }
  }

  function compactEl(e) {
    const out = { id: e.elementId, tag: e.tag };
    if (e.type === "action") {
      if (e.text) out.text = e.text;
      if (e.href) out.href = e.href;
      if (e.context) out.ctx = String(e.context).slice(0, 120);
      if (e.disabled) out.disabled = true;
    } else {
      if (e.label) out.label = e.label;
      if (e.fieldType) out.type = e.fieldType;
      if (e.required) out.req = true;
      if (e.options?.length) out.opts = e.options.slice(0, 12);
    }
    return out;
  }

  const compactActions = JSON.stringify(actions.map(compactEl));
  const compactHistory = (history || []).slice(-5).map((h) => {
    const out = { t: h.tool };
    if (h.elementId) out.el = h.elementId;
    if (h.url) out.url = h.url;
    if (h.reasoning) out.r = String(h.reasoning).slice(0, 60);
    return out;
  });

  const playbookAction = await lookupPlaybookAction(pageUrl, fields.length, elements, blockedIds);
  if (playbookAction) {
    if (playbookAction.tool === "navigate" && playbookAction.url) {
      const resolved = resolveUrl(playbookAction.url, pageUrl);
      if (
        resolved &&
        allowedUrls.has(resolved) &&
        isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl) &&
        !isForbiddenNavigationUrl(resolved, pageUrl)
      ) {
        return {
          ok: true,
          action: {
            tool: "navigate",
            elementId: null,
            url: resolved,
            text: null,
            value: null,
            reasoning: playbookAction.reasoning,
            fromPlaybook: true,
            coverLetterElementIds: [],
            coverLetterRevealIds: [],
            resumeElementIds: []
          }
        };
      }
    } else if ((playbookAction.tool === "click" || playbookAction.tool === "submit") && playbookAction.elementId) {
      const picked = allActions.find((e) => e.elementId === playbookAction.elementId);
      if (
        picked &&
        !blockedIds.has(playbookAction.elementId) &&
        !(picked.href && isForbiddenNavigationUrl(String(picked.href), pageUrl))
      ) {
        return {
          ok: true,
          action: {
            tool: playbookAction.tool,
            elementId: playbookAction.elementId,
            url: null,
            text: null,
            value: null,
            reasoning: playbookAction.reasoning,
            fromPlaybook: true,
            coverLetterElementIds: [],
            coverLetterRevealIds: [],
            resumeElementIds: []
          }
        };
      }
    }
  }

  if (!actions.length && !fields.length) {
    return {
      ok: true,
      action: {
        tool: "wait",
        elementId: null,
        url: null,
        text: null,
        value: null,
        reasoning: "No clickable elements yet — waiting for page to finish loading.",
        coverLetterElementIds: [],
        coverLetterRevealIds: [],
        resumeElementIds: []
      }
    };
  }

  const hasApplicationForm = fields.some((f) => f.fieldType === "file" || f.fieldType === "textarea" || f.fieldType === "contenteditable") || fields.length >= 8;

  const a11ySnapshot = await getA11ySnapshot(tabId).catch(() => null);

  const actionsText = actions.map((e) => {
    let line = `elementId="${e.elementId}" [${e.tag}] "${String(e.text || "").slice(0, 80)}"`;
    if (e.href) line += ` href="${e.href.slice(0, 120)}"`;
    if (e.context) line += ` ctx="${String(e.context).slice(0, 80)}"`;
    return line;
  }).join("\n");

  const prompt = [
    "You are controlling a browser to complete a job application.",
    "Choose ONE action that advances toward submitting the application.",
    'Return exactly: {"tool":"click|submit|navigate|wait|blocked","elementId":null,"url":null,"reasoning":""}',
    "- click: advance the form (Next, Continue, Accept terms, close modal)",
    "- submit: ONLY when this click would FINALLY submit the completed application to the employer, not for wizard Next/Continue steps",
    "- navigate: ONLY to one of the Allowed URLs",
    "- wait: page is still loading",
    "- blocked: genuinely cannot proceed",
    "Do NOT click profile, account, settings, dashboard, or inbox links.",
    pageHost === "workatastartup.com"
      ? "workatastartup: NEVER navigate. Only click Apply on the job listing page, never /application/* paths."
      : "",
    targetTitle ? `Job: "${targetTitle}" at ${targetCompany}` : "Target: apply on this page",
    `Target URL: ${targetApplyUrl}`,
    hiddenApplyUrl ? `Hidden apply URL: ${hiddenApplyUrl}` : "",
    `Current: ${pageUrl} (step ${stepIndex})`,
    blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
    compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
    allowedUrls.size ? `Allowed navigate URLs: ${JSON.stringify([...allowedUrls])}` : "No navigate URLs — use click only",
    hasApplicationForm
      ? `Form with ${fields.length} fields is present. Extension fills it automatically — only click Next/Continue/Submit.`
      : fields.length
        ? `${fields.length} form fields visible. Click to advance or submit.`
        : "No form yet. Find and click Apply or equivalent button in any language.",
    a11ySnapshot ? `PAGE STRUCTURE (accessibility tree):\n${a11ySnapshot}` : `PAGE TEXT:\n${String(pageText || "").slice(0, 1500)}`,
    actionsText ? `CLICKABLE ELEMENTS (use elementId from this list):\n${actionsText}` : ""
  ].filter(Boolean).join("\n\n");

  const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);

  const toolRaw = String(parsed.tool ?? "");
  const validTools = ["navigate", "click", "submit", "wait", "blocked"];
  const tool = validTools.includes(toolRaw) ? toolRaw : "wait";

  const elementIdRaw = parsed.elementId ? String(parsed.elementId) : "";
  let elementId = validElementIds.has(elementIdRaw) ? elementIdRaw : null;
  if (elementId) {
    const picked = allActions.find((e) => e.elementId === elementId);
    if (
      blockedIds.has(elementId) ||
      (picked && picked.href && isForbiddenNavigationUrl(String(picked.href), pageUrl))
    ) {
      elementId = null;
    }
  }

  const urlRaw = parsed.url ? resolveUrl(String(parsed.url), pageUrl) : "";
  let url =
    urlRaw && allowedUrls.has(urlRaw) && isAllowedNavigateUrl(urlRaw, pageUrl, pageHost, targetApplyUrl) ? urlRaw : null;

  let resolvedTool = tool === "navigate" && !url && elementId ? "click" : (tool === "click" || tool === "submit") && !elementId && url ? "navigate" : tool;
  if (pageHost === "workatastartup.com" && resolvedTool === "navigate") {
    resolvedTool = elementId ? "click" : "blocked";
  }
  if (url && isForbiddenNavigationUrl(url, pageUrl)) {
    url = null;
    if (resolvedTool === "navigate") {
      resolvedTool = elementId ? "click" : "blocked";
    }
  }
  if (resolvedTool === "click" && !elementId) {
    resolvedTool = "blocked";
  }
  if (resolvedTool === "navigate" && !url) {
    resolvedTool = "blocked";
  }
  if (resolvedTool === "wait" && compactHistory.length >= 2) {
    const lastTwo = compactHistory.slice(-2);
    if (lastTwo.every((h) => h.t === "wait")) {
      resolvedTool = "blocked";
    }
  }

  return { ok: true, action: { tool: resolvedTool, elementId, url, text: null, value: null, reasoning: String(parsed.reasoning ?? ""), coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] } };
}

function getApplySession(tabId) {
  const entry = applySessionByTabId.get(tabId);
  if (!entry) return null;
  if (typeof entry === "string") return { payloadUrl: entry, openerTabId: null };
  return entry;
}

function setApplySession(tabId, payloadUrl, openerTabId) {
  applySessionByTabId.set(tabId, { payloadUrl, openerTabId: openerTabId ?? null });
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => { });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "JOBMATE_APP_PAGE_READY") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }
      if (!(await shouldSyncConfigFromApp())) {
        sendResponse({ ok: true, synced: false });
        return;
      }
      try {
        const synced = await syncExtensionConfigFromTab(tabId);
        sendResponse({ ok: synced, synced });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_EXTENSION_CONFIG") {
    (async () => {
      if (!msg.config) {
        sendResponse({ ok: false });
        return;
      }
      await applyExtensionConfigFromApp(msg.config);
      await new Promise((resolve) => chrome.storage.local.set({ needsConfigFromApp: false }, resolve));
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = getApplySession(tabId);
  const notifyTabId = session?.openerTabId ?? null;
  const payloadUrl = session?.payloadUrl ?? "";
  const sessionJob = payloadUrl ? internalSessionJobData.get(payloadUrl) : null;
  const applyUrl = sessionJob?.applyUrl ?? "";
  applySessionByTabId.delete(tabId);

  for (const [payloadKey, automationTabId] of applyAutomationTabByPayload.entries()) {
    if (automationTabId === tabId) {
      applyAutomationTabByPayload.delete(payloadKey);
    }
  }

  const closedPayload = {
    type: "JOBMATE_APPLY_CLOSED",
    tabId,
    applyUrl: typeof applyUrl === "string" ? applyUrl : ""
  };

  if (notifyTabId) {
    await chrome.tabs.sendMessage(notifyTabId, closedPayload).catch(() => { });
    return;
  }

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url || "";
    if (!tab.id) continue;
    if (!isJobMateAppUrl(url)) continue;
    await chrome.tabs.sendMessage(tab.id, closedPayload).catch(() => { });
  }
});

function payloadForAutomationTab(tabId) {
  const session = getApplySession(tabId);

  if (session?.payloadUrl) {
    return { payloadUrl: session.payloadUrl, uiTabId: session.openerTabId ?? null };
  }

  for (const [payloadUrl, autoTabId] of applyAutomationTabByPayload.entries()) {
    if (autoTabId === tabId) {
      const autoSession = getApplySession(tabId);
      return { payloadUrl, uiTabId: autoSession?.openerTabId ?? null };
    }
  }

  return null;
}

async function registerApplyAutomationTab(tabId, payloadUrl, uiTabId) {
  applyAutomationTabByPayload.set(payloadUrl, tabId);
  setApplySession(tabId, payloadUrl, uiTabId);
  await chrome.tabs.update(tabId, { active: false }).catch(() => { });
}

async function openApplyAutomationTab(url, payloadUrl, uiTabId, groupId = null) {
  const existingId = applyAutomationTabByPayload.get(payloadUrl);

  if (existingId) {
    const existing = await chrome.tabs.get(existingId).catch(() => null);

    if (existing?.id) {
      applyAutomationTabByPayload.set(payloadUrl, existingId);
      setApplySession(existingId, payloadUrl, uiTabId);
      await chrome.tabs.update(existingId, { url, active: false }).catch(() => { });
      return existingId;
    }

    applyAutomationTabByPayload.delete(payloadUrl);
  }

  const created = await chrome.tabs.create({ url, active: false });
  const tabId = created.id;

  if (!tabId) {
    throw new Error("Failed to create apply automation tab.");
  }

  applyAutomationTabByPayload.set(payloadUrl, tabId);
  setApplySession(tabId, payloadUrl, uiTabId);
  await chrome.tabs.update(tabId, { active: false }).catch(() => { });

  if (groupId != null) {
    await addTabToGroup(tabId, groupId).catch(() => { });
  } else {
    const newGroupId = await chrome.tabs.group({ tabIds: [tabId] }).catch(() => null);
    if (newGroupId != null) {
      await chrome.tabGroups.update(newGroupId, { title: "JobMate Apply", color: "green" }).catch(() => { });
    }
  }

  return tabId;
}

function payloadUrlFromApplyTabUrl(url) {
  try {
    const hash = url.split("#")[1] || "";
    const value = new URLSearchParams(hash).get("jobmatePayload");
    return value ? decodeURIComponent(value) : "";
  } catch {
    return "";
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const tabId = tab.id;
  const openerId = tab.openerTabId;

  if (!tabId || !openerId) {
    return;
  }

  const automation = payloadForAutomationTab(openerId);

  if (!automation) {
    return;
  }

  applyAutomationTabByPayload.set(automation.payloadUrl, tabId);
  setApplySession(tabId, automation.payloadUrl, automation.uiTabId);
  applySessionByTabId.delete(openerId);
  void chrome.tabs.remove(openerId);
  void chrome.tabs.update(tabId, { active: false });
});

async function createIsolatedCrawlerTab(initialUrl = "about:blank") {
  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  if (!tab?.id) throw new Error("Failed to create crawler tab.");

  const groupId = await chrome.tabs.group({ tabIds: [tab.id] }).catch(() => null);
  if (groupId != null) {
    await chrome.tabGroups.update(groupId, { title: "JobMate Crawl", color: "grey", collapsed: true }).catch(() => { });
  }

  return { tabId: tab.id, windowId: tab.windowId, groupId };
}

async function closeIsolatedCrawlerWindow(windowId, tabId) {
  if (tabId != null) {
    await chrome.tabs.remove(tabId).catch(() => { });
  }
}

function waitTabComplete(tabId, ms = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab load timeout"));
    }, ms);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== "complete") {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (tab?.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

function extractPageHtmlInjected() {
  function isSecurityCheckText(text) {
    return /security checkup|Enable JavaScript and cookies to continue|challenge-platform|__CF\$cv/i.test(String(text || ""));
  }

  const html = document.documentElement?.outerHTML || "";
  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return {
    href: location.href,
    title: document.title || "",
    html,
    security: Boolean(bodyText) && (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText))
  };
}

async function readTabHtmlSnapshot(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageHtmlInjected
  });

  return injected[0]?.result || { href: "", title: "", html: "", security: false };
}

async function waitForTabHtml(tabId, timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snap = await readTabHtmlSnapshot(tabId);

    if (snap.html && !snap.security) {
      return snap;
    }

    await sleep(900);
  }

  throw new Error("Timed out waiting for page HTML.");
}

function scrapeGoogleOrganicInjected() {
  const out = [];
  const seen = new Set();

  function unwrapGoogleRedirect(href) {
    let h = href;

    if (/google\.[^/]+\/url\?/i.test(h) || /^\/url\?/i.test(h) || /\/url\?/i.test(h)) {
      try {
        const u = new URL(h, "https://www.google.com");
        const q = u.searchParams.get("q") || u.searchParams.get("url");

        if (q) {
          h = q;
        }
      } catch (_) { }
    }

    return h;
  }

  function normalizeAnchorHref(a) {
    let href = a.getAttribute("href") || "";

    if (href.startsWith("/")) {
      try {
        href = new URL(href, "https://www.google.com").href;
      } catch (_) {
        return "";
      }
    }

    href = unwrapGoogleRedirect(href);

    if (!/^https?:\/\//i.test(href)) {
      return "";
    }

    try {
      const hostname = new URL(href).hostname;

      if (/^google\./i.test(hostname) || /googleusercontent\.com$/i.test(hostname)) {
        return "";
      }

      return href;
    } catch (_) {
      return "";
    }
  }

  function titleFromAnchor(a, h3) {
    if (h3) {
      const t = String(h3.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (t.length >= 2) {
        return t;
      }
    }

    const heading = a.querySelector('[role="heading"]');

    if (heading) {
      const t = String(heading.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (t.length >= 2) {
        return t;
      }
    }

    return "";
  }

  function snippetForAnchor(a, title) {
    let snippet = "";
    const block = a.closest("div[data-hveid], div.g, div[jscontroller], div[data-snf], div.MjjYud");

    if (block) {
      const spans = block.querySelectorAll("span");

      for (const sp of spans) {
        const t = String(sp.textContent || "")
          .replace(/\s+/g, " ")
          .trim();

        if (t.length > 40 && t !== title && !/^https?:\/\//i.test(t)) {
          snippet = t.slice(0, 240);
          break;
        }
      }
    }

    return snippet;
  }

  function pushResult(href, title, a) {
    if (!href || !title || seen.has(href)) {
      return;
    }

    seen.add(href);

    let hostname = "";

    try {
      hostname = new URL(href).hostname;
    } catch (_) {
      return;
    }

    out.push({
      title,
      link: href,
      displayedLink: hostname.replace(/^www\./i, ""),
      snippet: snippetForAnchor(a, title)
    });
  }

  const rso = document.querySelector("#rso");
  const roots = [];

  if (rso) {
    roots.push(rso);
  }

  roots.push(document.body);

  for (const root of roots) {
    const headers = root.querySelectorAll("a h3");

    for (const h3 of headers) {
      const a = h3.closest("a");

      if (!a) {
        continue;
      }

      const href = normalizeAnchorHref(a);
      const title = titleFromAnchor(a, h3);

      if (!href || !title) {
        continue;
      }

      pushResult(href, title, a);

      if (out.length >= 50) {
        return out;
      }
    }
  }

  if (out.length < 8 && rso) {
    const anchors = rso.querySelectorAll('a[href^="http"], a[href^="/url"]');

    for (const a of anchors) {
      const href = normalizeAnchorHref(a);

      if (!href) {
        continue;
      }

      const title = titleFromAnchor(a, a.querySelector("h3"));

      if (!title) {
        continue;
      }

      pushResult(href, title, a);

      if (out.length >= 50) {
        break;
      }
    }
  }

  return out;
}

function scrapeJobTeaserSearchInjected() {
  function isSecurityCheckText(text) {
    return /security checkup|Enable JavaScript and cookies to continue|challenge-platform|__CF\$cv/i.test(String(text || ""));
  }

  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a.JobAdCard-module__gW-NAa__link[href*="/job-offers/"]');

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    let absoluteHref = "";

    try {
      absoluteHref = new URL(href, location.href).toString();
    } catch (_) {
      continue;
    }

    if (!absoluteHref || seen.has(absoluteHref)) {
      continue;
    }

    const title = String(anchor.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title) {
      continue;
    }

    seen.add(absoluteHref);

    const card = anchor.closest('[data-testid="jobad-card"]') || anchor.closest("li") || anchor.parentElement;
    const company = String(card?.querySelector('[data-testid="jobad-card-company-name"]')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const contract = String(card?.querySelector('[data-testid="jobad-card-contract"] span:last-of-type')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const locationText = String(card?.querySelector('[data-testid="jobad-card-location"] span:last-of-type')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    let sourceHost = "";

    try {
      sourceHost = new URL(absoluteHref).hostname.replace(/^www\./i, "");
    } catch (_) {
      sourceHost = "jobteaser.com";
    }

    out.push({
      sourceUrl: absoluteHref,
      sourceTitle: title,
      sourceHost,
      company: company || "Company",
      location: locationText || "Unknown",
      snippet: [company, contract, locationText].filter(Boolean).join(" · ")
    });
  }

  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const security =
    out.length === 0 &&
    Boolean(bodyText) &&
    (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText));

  return { security, results: out };
}

function scrapeWorkAtAStartupSearchInjected() {
  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isSecurityCheckText(text) {
    return /security check|verify you are human|enable javascript and cookies|cf[- ]challenge|checking your browser/i.test(
      String(text || "")
    );
  }

  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/jobs/"]');

  for (const anchor of anchors) {
    let absoluteHref = "";
    let parsedHref = null;

    try {
      absoluteHref = new URL(anchor.getAttribute("href") || "", location.href).toString();
      parsedHref = new URL(absoluteHref);
    } catch (_) {
      continue;
    }

    if (
      !parsedHref ||
      parsedHref.hostname.replace(/^www\./i, "").toLowerCase() !== "workatastartup.com" ||
      !/^\/jobs\/\d+\/?$/i.test(parsedHref.pathname) ||
      seen.has(absoluteHref)
    ) {
      continue;
    }

    const title = cleanText(anchor.textContent);

    if (!title || /^view job$/i.test(title)) {
      continue;
    }

    seen.add(absoluteHref);

    const card =
      anchor.closest("div.mb-2") ||
      anchor.closest("article") ||
      anchor.closest("li") ||
      anchor.parentElement;
    const metaParts = Array.from(card?.querySelectorAll("span") || [])
      .map((node) => cleanText(node.textContent))
      .filter((part) => part && !/^job match$/i.test(part) && !/^view job$/i.test(part));
    const locationText =
      metaParts.find((part) => /(remote|hybrid|on[- ]site|[A-Za-z .'-]+,\s*[A-Z]{2},\s*[A-Z]{2})/i.test(part)) || "Unknown";

    out.push({
      sourceUrl: absoluteHref,
      sourceTitle: title,
      sourceHost: "workatastartup.com",
      company: "Company",
      location: locationText,
      snippet: metaParts.join(" · ")
    });
  }

  const bodyText = cleanText(document.body?.innerText || "").slice(0, 4000);
  const security =
    out.length === 0 &&
    Boolean(bodyText) &&
    (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText));

  return { security, results: out };
}

async function scrapeQueryAllPages(tabId, query, limit) {
  const collected = [];
  const seenLinks = new Set();
  let start = 0;
  const maxPages = 15;

  for (let page = 0; page < maxPages && collected.length < limit; page++) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&nfpr=1&filter=0&start=${start}`;
    await chrome.tabs.update(tabId, { url });
    await waitTabComplete(tabId);
    await sleep(550);

    let results = [];

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeGoogleOrganicInjected
        });
        results = injected[0]?.result || [];
      } catch (_) {
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      await sleep(380 + attempt * 140);
    }

    if (!results.length) {
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.link || seenLinks.has(row.link)) {
        continue;
      }

      seenLinks.add(row.link);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }

    start += 10;
  }

  return collected.slice(0, limit);
}

async function scrapeJobTeaserSpec(tabId, spec, limit) {
  const collected = [];
  const seenLinks = new Set();
  const maxPages = Math.max(1, Math.min(10, Math.ceil(limit / 20) + 1));

  for (let page = 1; page <= maxPages && collected.length < limit; page++) {
    const url = new URL(spec.url);

    if (page > 1) {
      url.searchParams.set("page", String(page));
    } else {
      url.searchParams.delete("page");
    }

    await chrome.tabs.update(tabId, { url: url.toString() });
    await waitTabComplete(tabId);

    let results = [];
    let security = false;

    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeJobTeaserSearchInjected
        });
        const payload = injected[0]?.result || { security: false, results: [] };
        security = Boolean(payload.security);
        results = Array.isArray(payload.results) ? payload.results : [];
      } catch (_) {
        security = false;
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      if (!security && attempt >= 4) {
        break;
      }

      await sleep(900);
    }

    if (!results.length) {
      if (security) {
        throw new Error(`JobTeaser page stayed behind a security check for ${spec.label}.`);
      }
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.sourceUrl || seenLinks.has(row.sourceUrl)) {
        continue;
      }

      seenLinks.add(row.sourceUrl);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }
  }

  return collected.slice(0, limit);
}

async function scrapeWorkAtAStartupSpec(tabId, spec, limit) {
  const collected = [];
  const seenLinks = new Set();
  const maxPages = Math.max(1, Math.min(10, Math.ceil(limit / 20) + 1));

  for (let page = 1; page <= maxPages && collected.length < limit; page++) {
    const url = new URL(spec.url);

    if (page > 1) {
      url.searchParams.set("page", String(page));
    } else {
      url.searchParams.delete("page");
    }

    await chrome.tabs.update(tabId, { url: url.toString() });
    await waitTabComplete(tabId);

    let results = [];
    let security = false;

    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeWorkAtAStartupSearchInjected
        });
        const payload = injected[0]?.result || { security: false, results: [] };
        security = Boolean(payload.security);
        results = Array.isArray(payload.results) ? payload.results : [];
      } catch (_) {
        security = false;
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      if (!security && attempt >= 6) {
        break;
      }

      await sleep(900);
    }

    if (!results.length) {
      if (security) {
        throw new Error(`Work at a Startup page stayed behind a security check for ${spec.label}.`);
      }
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.sourceUrl || seenLinks.has(row.sourceUrl)) {
        continue;
      }

      seenLinks.add(row.sourceUrl);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }
  }

  return collected.slice(0, limit);
}

async function runGoogleBatch(queryList, limitPerQuery) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const byQuery = {};

  try {
    for (const query of queryList) {
      byQuery[query] = await scrapeQueryAllPages(crawler.tabId, query, limitPerQuery);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId, crawler.tabId);
  }

  return byQuery;
}

async function runJobTeaserBatch(specs, limitPerSpec) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const bySpecId = {};

  try {
    for (const spec of specs) {
      bySpecId[spec.id] = await scrapeJobTeaserSpec(crawler.tabId, spec, limitPerSpec);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId, crawler.tabId);
  }

  return bySpecId;
}

async function runWorkAtAStartupBatch(specs, limitPerSpec) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const bySpecId = {};

  try {
    for (const spec of specs) {
      bySpecId[spec.id] = await scrapeWorkAtAStartupSpec(crawler.tabId, spec, limitPerSpec);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId, crawler.tabId);
  }

  return bySpecId;
}

async function fetchPageHtmlInHiddenTab(url) {
  const crawler = await createIsolatedCrawlerTab(url);

  try {
    await waitTabComplete(crawler.tabId);
    const snap = await waitForTabHtml(crawler.tabId);
    return {
      ok: true,
      finalUrl: snap.href || url,
      html: snap.html || ""
    };
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId, crawler.tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "JOBMATE_APPLY_SESSION_SET") {
    (async () => {
      if (sender.tab?.id && typeof msg.payloadUrl === "string" && msg.payloadUrl.trim()) {
        const payloadUrl = msg.payloadUrl.trim();
        const existing = getApplySession(sender.tab.id);
        const uiTabId = existing?.openerTabId ?? sender.tab.openerTabId ?? null;
        await registerApplyAutomationTab(sender.tab.id, payloadUrl, uiTabId);
      }

      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_OPEN_BACKGROUND_TAB") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      try {
        const tab = await chrome.tabs.create({ url, active: false });
        sendResponse({ ok: true, tabId: tab.id ?? null });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_OPEN_APPLY_TAB") {
    (async () => {
      const applyUrl = typeof msg.url === "string" ? msg.url.trim() : "";
      const senderTabId = sender.tab?.id ?? null;

      if (!applyUrl) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      let sessionUrl = applyUrl;
      let sessionKey = typeof msg.payloadUrl === "string" ? msg.payloadUrl.trim() : "";

      if (msg.sessionId) {
        const sessionId = String(msg.sessionId);
        sessionKey = `ext://session/${sessionId}`;
        if (msg.jobData && typeof msg.jobData === "object") {
          internalSessionJobData.set(sessionKey, {
            applyUrl,
            title: String(msg.jobData.title || ""),
            company: String(msg.jobData.company || ""),
            listingText: String(msg.jobData.listingText || ""),
            jobId: String(msg.jobData.jobId || ""),
            companyHomepage: String(msg.jobData.companyHomepage || ""),
            linkedinLinks: Array.isArray(msg.jobData.linkedinLinks) ? msg.jobData.linkedinLinks.map(String) : [],
            hiringContacts: Array.isArray(msg.jobData.hiringContacts) ? msg.jobData.hiringContacts.map(String) : [],
            coverLetterText: ""
          });
        }
        const u = new URL(applyUrl);
        u.hash = `jobmateSession=${encodeURIComponent(sessionId)}`;
        sessionUrl = u.toString();
      }

      if (!sessionKey) {
        sendResponse({ ok: false, error: "No session key" });
        return;
      }

      try {
        const tabId = await openApplyAutomationTab(sessionUrl, sessionKey, senderTabId);

        if (senderTabId) {
          await chrome.tabs
            .sendMessage(senderTabId, {
              type: "JOBMATE_APPLY_STARTED",
              tabId,
              applyUrl
            })
            .catch(() => { });
        }

        sendResponse({ ok: true, tabId });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_INTERRUPT_APPLY_TAB") {
    (async () => {
      const tabId = typeof msg.tabId === "number" ? msg.tabId : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing apply tab id." });
        return;
      }

      const applyTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!applyTab?.id) {
        sendResponse({ ok: false, error: "Apply tab not found." });
        return;
      }

      await chrome.tabs
        .sendMessage(tabId, {
          type: "JOBMATE_FORCE_INTERRUPT",
          reason: "Interrupted by user.",
          instruction: "Complete the action needed to unblock this application, then click Continue."
        })
        .catch(() => { });
      await chrome.windows.update(applyTab.windowId, { focused: true }).catch(() => { });
      await chrome.tabs.update(tabId, { active: true }).catch(() => { });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_IS_RUNNER") {
    const tabId = sender.tab?.id;
    const payloadUrl = typeof msg.payloadUrl === "string" ? msg.payloadUrl.trim() : "";
    const automationTabId = payloadUrl ? applyAutomationTabByPayload.get(payloadUrl) : null;

    sendResponse({ ok: Boolean(tabId && automationTabId === tabId) });
    return false;
  }

  if (msg?.type === "JOBMATE_EMAIL_SYNC") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL", text: "" });
        return;
      }

      let tabId = null;

      try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitTabComplete(tabId);
        await sleep(3000);
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40000)
        });
        const text = injected[0]?.result || "";
        await chrome.tabs.remove(tabId).catch(() => { });
        tabId = null;
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err), text: "" });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_NEEDS_ATTENTION") {
    (async () => {
      const applyTabId = sender.tab?.id;
      const session = applyTabId ? getApplySession(applyTabId) : null;
      const applyTab = applyTabId ? await chrome.tabs.get(applyTabId).catch(() => null) : null;
      const notifyTabId = session?.openerTabId ?? applyTab?.openerTabId ?? null;
      const payload = {
        type: "JOBMATE_APPLY_ATTENTION",
        message: typeof msg.message === "string" ? msg.message : "",
        instruction: typeof msg.instruction === "string" ? msg.instruction : "",
        applyUrl: typeof msg.applyUrl === "string" ? msg.applyUrl : applyTab?.url || ""
      };

      if (notifyTabId) {
        await chrome.tabs.sendMessage(notifyTabId, payload).catch(() => { });
      }

      if (applyTabId && applyTab?.windowId) {
        await chrome.windows.update(applyTab.windowId, { focused: true }).catch(() => { });
        await chrome.tabs.update(applyTabId, { active: true }).catch(() => { });
      } else if (!notifyTabId) {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          const url = tab.url || "";
          if (!tab.id || tab.id === applyTabId) continue;
          if (!isJobMateAppUrl(url)) continue;
          await chrome.tabs.sendMessage(tab.id, payload).catch(() => { });
        }
      }

      sendResponse({ ok: true });
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_RESET_URL_OSCILLATION") {
    const tabId = sender.tab?.id;
    if (tabId) applyPageUrlOscillationByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_SESSION_LOOKUP") {
    (async () => {
      const tabId = sender.tab?.id;

      if (!tabId) {
        sendResponse({ ok: true, payloadUrl: null });
        return;
      }

      const session = getApplySession(tabId);
      const payloadUrl = session?.payloadUrl ?? "";
      const automationTabId = payloadUrl ? applyAutomationTabByPayload.get(payloadUrl) : null;

      if (!payloadUrl || automationTabId !== tabId) {
        sendResponse({ ok: true, payloadUrl: null });
        return;
      }

      sendResponse({ ok: true, payloadUrl });
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_SESSION_CLEAR") {
    const tabId = sender.tab?.id;
    const session = tabId ? getApplySession(tabId) : null;
    const payloadUrl = session?.payloadUrl ?? "";

    if (tabId) {
      applySessionByTabId.delete(tabId);
    }

    if (payloadUrl) {
      applyAutomationTabByPayload.delete(payloadUrl);
    }

    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "jobmate_fetch") {
    (async () => {
      let replied = false;

      function reply(payload) {
        if (!replied) {
          replied = true;
          sendResponse(payload);
        }
      }

      try {
        const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
        const headers = msg.headers && typeof msg.headers === "object" ? msg.headers : {};
        const init = {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : msg.body
        };

        let res = await fetch(msg.url, init).catch(() => null);

        if (!res) {
          await sleep(200);
          res = await fetch(msg.url, init);
        }

        const text = await res.text();
        reply({ ok: res.ok, status: res.status, text });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true;
  }

  if (msg?.type === "GOOGLE_SEARCH_BATCH") {
    (async () => {
      const queryList = Array.isArray(msg.queries) ? msg.queries.map(String) : [];
      const limitPerQuery = Math.max(1, Math.min(100, Number(msg.limitPerQuery) || 100));

      if (!queryList.length) {
        sendResponse({ ok: false, error: "No queries", byQuery: {} });
        return;
      }

      try {
        const byQuery = await runGoogleBatch(queryList, limitPerQuery);
        sendResponse({ ok: true, byQuery });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          byQuery: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "JOBTEASER_SEARCH_BATCH") {
    (async () => {
      const specs = Array.isArray(msg.specs)
        ? msg.specs
          .filter((spec) => spec && typeof spec.id === "string" && typeof spec.url === "string")
          .map((spec) => ({
            id: String(spec.id),
            label: String(spec.label || spec.id),
            url: String(spec.url)
          }))
        : [];
      const limitPerSpec = Math.max(1, Math.min(100, Number(msg.limitPerSpec) || 100));

      if (!specs.length) {
        sendResponse({ ok: false, error: "No JobTeaser specs", bySpecId: {} });
        return;
      }

      try {
        const bySpecId = await runJobTeaserBatch(specs, limitPerSpec);
        sendResponse({ ok: true, bySpecId });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          bySpecId: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "WORKATASTARTUP_SEARCH_BATCH") {
    (async () => {
      const specs = Array.isArray(msg.specs)
        ? msg.specs
          .filter((spec) => spec && typeof spec.id === "string" && typeof spec.url === "string")
          .map((spec) => ({
            id: String(spec.id),
            label: String(spec.label || spec.id),
            url: String(spec.url)
          }))
        : [];
      const limitPerSpec = Math.max(1, Math.min(100, Number(msg.limitPerSpec) || 100));

      if (!specs.length) {
        sendResponse({ ok: false, error: "No Work at a Startup specs", bySpecId: {} });
        return;
      }

      try {
        const bySpecId = await runWorkAtAStartupBatch(specs, limitPerSpec);
        sendResponse({ ok: true, bySpecId });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          bySpecId: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_ADHOC_FILL_REQUEST") {
    (async () => {
      const pageTabId = typeof msg.pageTabId === "number" ? msg.pageTabId : null;
      const pageUrl = typeof msg.pageUrl === "string" ? msg.pageUrl.trim() : "";

      if (!pageTabId || !pageUrl) {
        sendResponse({ ok: false, error: "Missing tab info." });
        return;
      }

      const cfg = await getExtensionConfig();
      if (!cfg.geminiApiKey?.trim()) {
        sendResponse({ ok: false, error: "Add a Gemini API key in the extension settings first." });
        return;
      }

      const sessionId = crypto.randomUUID();
      const sessionKey = `ext://session/${sessionId}`;
      internalSessionJobData.set(sessionKey, {
        applyUrl: pageUrl,
        title: "",
        company: "",
        listingText: "",
        jobId: "",
        companyHomepage: "",
        linkedinLinks: [],
        hiringContacts: [],
        coverLetterText: ""
      });

      await registerApplyAutomationTab(pageTabId, sessionKey, null);
      await chrome.tabs.update(pageTabId, { active: true }).catch(() => { });

      const started = await chrome.tabs.sendMessage(pageTabId, { type: "JOBMATE_START_APPLY" }).catch(() => null);
      if (!started?.ok) {
        sendResponse({ ok: false, error: "Could not start autofill on this tab. Reload the page and try again." });
        return;
      }
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_GET_PAYLOAD") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      const cfg = await getExtensionConfig();
      const jobData = getSessionJobData(tabId);
      const resumeUpload = cfg.resumePdfBase64
        ? { name: cfg.resumePdfFilename || "resume.pdf", mimeType: cfg.resumePdfMimeType || "application/pdf", base64: cfg.resumePdfBase64 }
        : null;
      sendResponse({
        ok: true,
        payload: {
          applyUrl: jobData.applyUrl || "",
          title: jobData.title || "",
          company: jobData.company || "",
          jobId: jobData.jobId || "",
          listingText: jobData.listingText || "",
          coverLetterText: jobData.coverLetterText || "",
          coverUpload: null,
          resumeUpload,
          candidateEmail: cfg.candidateEmail || "",
          candidateFullName: cfg.candidateName || "",
          linkedinLinks: jobData.linkedinLinks || [],
          hiringContacts: jobData.hiringContacts || []
        }
      });
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_COVER_LETTER_EDITOR_READY") {
    const sessionId = String(msg.sessionId || "");
    const entry = coverLetterReviewBySession.get(sessionId);
    sendResponse({ ok: Boolean(entry), draft: entry?.draft ?? "", error: entry ? "" : "Session expired." });
    return true;
  }

  if (msg?.type === "JOBMATE_COVER_LETTER_EDITOR_DONE") {
    const sessionId = String(msg.sessionId || "");
    const entry = coverLetterReviewBySession.get(sessionId);
    if (entry) {
      coverLetterReviewBySession.delete(sessionId);
      const action = msg.action === "save" ? "save" : "reject";
      const text = action === "save" ? String(msg.text || "").trim() : "";
      entry.resolve({ ok: true, action, text });
      if (entry.openerTabId) {
        chrome.tabs.update(entry.openerTabId, { active: true }).catch(() => { });
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "JOBMATE_COVER_LETTER_REVIEW") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "No tab." });
        return;
      }
      try {
        const existing = coverLetterReviewByTab.get(tabId);
        if (existing?.decision) {
          sendResponse(existing.decision);
          return;
        }
        if (existing?.promise) {
          sendResponse(await existing.promise);
          return;
        }

        let draft = String(msg.draft || "").trim();
        if (!draft) {
          const cfg = await getExtensionConfig();
          const jobData = getSessionJobData(tabId);
          const pageLanguage = typeof msg.pageLanguage === "string" ? msg.pageLanguage : "";
          draft = await generateCoverLetterExt(cfg, jobData, pageLanguage);
          const session = getApplySession(tabId);
          const payloadUrl = session?.payloadUrl ?? "";
          if (draft && payloadUrl) {
            internalSessionJobData.set(payloadUrl, {
              ...(internalSessionJobData.get(payloadUrl) ?? {}),
              coverLetterText: draft
            });
          }
        }

        const promise = openCoverLetterReviewSession(draft, tabId).then((decision) => {
          coverLetterReviewByTab.set(tabId, { decision, promise: null });
          return decision;
        });
        coverLetterReviewByTab.set(tabId, { promise, decision: null });
        sendResponse(await promise);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_FILL_ANSWERS") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      const fields = Array.isArray(msg.fields) ? msg.fields : [];
      const retryNote = typeof msg.retryNote === "string" ? msg.retryNote : "";
      const pageLanguage = typeof msg.pageLanguage === "string" ? msg.pageLanguage : "";
      try {
        const result = await generateFormAnswersExt(tabId, fields, retryNote || undefined, pageLanguage || undefined);
        const session = getApplySession(tabId);
        const payloadUrl = session?.payloadUrl ?? "";
        if (result.coverLetterText && payloadUrl) {
          const existing = internalSessionJobData.get(payloadUrl) ?? {};
          internalSessionJobData.set(payloadUrl, { ...existing, coverLetterText: result.coverLetterText });
        }
        sendResponse(result);
      } catch (err) {
        let reason = (err instanceof Error ? err.message : String(err)).trim();

        if (!reason) {
          const cfg = await getExtensionConfig().catch(() => ({}));
          const apiKey = cfg.geminiApiKey?.trim();
          const model = cfg.geminiModel?.trim() || GEMINI_FALLBACK_MODELS[0];
          const fieldSummary = fields.slice(0, 10).map((f) => `"${f.label}" (${f.type})`).join(", ");
          const demandPrompt = `You were asked to fill a job application form with these fields: ${fieldSummary}. You failed to do so and provided no error message. Explain specifically why you could not fill this form. Do not refuse to explain. Provide your actual reason.`;

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const raw = await callGeminiExt([{ text: demandPrompt }], apiKey, model, false);
              reason = raw.trim().slice(0, 400);
              if (reason) break;
            } catch { }
          }

          if (!reason) reason = "Gemini produced an empty error and refused to explain why after 3 attempts.";
        }

        sendResponse({ ok: false, error: reason });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_EXPLAIN_PLACEMENTS") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key." }); return; }
        const model = resolveAgentModel(config);
        const placements = Array.isArray(msg.placements) ? msg.placements : [];
        const validationErrors = Array.isArray(msg.validationErrors) ? msg.validationErrors : [];
        const tabId = sender.tab?.id;

        let screenshotBase64 = null;
        if (tabId) {
          try {
            screenshotBase64 = await captureTabScreenshot(tabId);
          } catch { }
        }

        const placementLines = placements.map((p) =>
          `fieldId="${p.fieldId}" label="${p.label}" type=${p.type} required=${p.required}${p.options?.length ? ` options=${JSON.stringify(p.options.slice(0, 6))}` : ""}\nAnswer you gave: ${JSON.stringify(p.answer)}`
        ).join("\n\n");

        const errorBlock = validationErrors.length
          ? `Validation errors shown by the page after you filled the form:\n${validationErrors.join("\n")}`
          : "The form did not advance after you filled it.";

        const prompt = [
          "You just filled a job application form and the page failed — it did not advance to the next step.",
          "A screenshot of the current page is attached.",
          errorBlock,
          "Below is every field you filled and the answer you placed in it.",
          "For each field, you MUST:",
          "  1. State exactly why you placed that specific answer in that field.",
          "  2. If your answer was wrong, provide the corrected answer.",
          "  3. If your answer was correct, explain why the validation error occurred for another reason.",
          "Be specific. Name the exact instruction, assumption, or reasoning that caused each placement.",
          "Return JSON array only: [{\"fieldId\":\"\",\"label\":\"\",\"type\":\"\",\"answer\":\"\",\"reasoning\":\"\",\"correctedAnswer\":\"\"}]",
          `Candidate email: ${config.candidateEmail?.trim() || ""}`,
          `Candidate name: ${config.candidateName?.trim() || ""}`,
          `Context:\n${config.contextBlock || ""}`,
          `Placements:\n${placementLines}`
        ].filter(Boolean).join("\n\n");

        const explainParts = [{ text: prompt }];
        if (screenshotBase64) {
          explainParts.push({ inline_data: { mime_type: "image/jpeg", data: screenshotBase64 } });
        }

        const raw = await callGeminiExt(explainParts, apiKey, model, true);
        const parsed = parseJsonObjectExt(raw);
        const items = Array.isArray(parsed) ? parsed : (parsed?.answers ?? []);

        const explanations = placements.map((p) => {
          const match = items.find((i) => String(i.fieldId ?? "") === p.fieldId);
          return {
            fieldId: p.fieldId,
            label: p.label,
            type: p.type,
            answer: p.answer,
            reasoning: match ? String(match.reasoning ?? match.reason ?? "") : "No explanation returned.",
            correctedAnswer: match ? String(match.correctedAnswer ?? match.answer ?? p.answer) : p.answer
          };
        });

        sendResponse({ ok: true, explanations });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_VALIDATE_ADVANCE") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const result = await validatePageAdvanceExt(tabId, msg);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_ANALYZE_PAGE") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const result = await nextBrowserActionExt(tabId, msg);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_SESSION_COMPLETE") {
    (async () => {
      const tabId = sender.tab?.id;
      const session = tabId ? getApplySession(tabId) : null;
      const payloadUrl = session?.payloadUrl ?? "";
      if (payloadUrl && payloadUrl.startsWith("ext://session/")) {
        internalSessionJobData.delete(payloadUrl);
      }
      if (tabId) {
        applySessionByTabId.delete(tabId);
        coverLetterReviewByTab.delete(tabId);
      }
      if (payloadUrl) applyAutomationTabByPayload.delete(payloadUrl);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "FETCH_PAGE_HTML") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      try {
        const payload = await fetchPageHtmlInHiddenTab(url);
        sendResponse(payload);
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true;
  }

  return false;
});
