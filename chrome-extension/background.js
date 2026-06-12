importScripts("jobmate-app-url.js", "apply-navigation.js", "browser-agent-router.js", "apply-domain-playbook.js");

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

const jobMateGroupTabs = new Map();
const webApplyGroupByWindow = new Map();

function tabEditErrorMessage() {
  const err = chrome.runtime.lastError;
  return err?.message ?? "";
}

function isTabEditBusyError(message) {
  return message.includes("cannot be edited");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTabEditRetry(operation, options = {}) {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 120;
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const result = await operation();
      const message = tabEditErrorMessage();
      if (message) {
        throw new Error(message);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isTabEditBusyError(message)) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(message);
      if (i < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("Tab edit operation failed.");
}

function trackJobMateGroupTab(groupId, tabId) {
  if (groupId == null || tabId == null) {
    return;
  }

  let tabIds = jobMateGroupTabs.get(groupId);

  if (!tabIds) {
    tabIds = new Set();
    jobMateGroupTabs.set(groupId, tabIds);
  }

  tabIds.add(tabId);
}

async function untrackJobMateGroupTab(tabId) {
  for (const [groupId, tabIds] of jobMateGroupTabs.entries()) {
    if (!tabIds.has(tabId)) {
      continue;
    }

    tabIds.delete(tabId);

    const remaining = await chrome.tabs.query({ groupId }).catch(() => []);

    if (!remaining.length) {
      jobMateGroupTabs.delete(groupId);

      for (const [windowId, mappedGroupId] of webApplyGroupByWindow.entries()) {
        if (mappedGroupId === groupId) {
          webApplyGroupByWindow.delete(windowId);
        }
      }
    }

    if (!tabIds.size) {
      jobMateGroupTabs.delete(groupId);
    }

    break;
  }
}

async function createTaskTabGroup(title, color = "blue") {
  const dummy = await chrome.tabs.create({ url: "about:blank", active: false });
  const groupId = await withTabEditRetry(() => chrome.tabs.group({ tabIds: [dummy.id] }));
  await withTabEditRetry(() => chrome.tabGroups.update(groupId, { title, color, collapsed: false }));
  await withTabEditRetry(() => chrome.tabs.remove(dummy.id));
  trackJobMateGroupTab(groupId, dummy.id);
  return groupId;
}

async function addTabToGroup(tabId, groupId) {
  await withTabEditRetry(() => chrome.tabs.group({ tabIds: [tabId], groupId }));
  trackJobMateGroupTab(groupId, tabId);
}

async function openTabInGroup(url, groupId, active = false) {
  const tab = await chrome.tabs.create({ url, active });
  if (groupId != null && tab?.id) {
    await addTabToGroup(tab.id, groupId);
  }
  return tab;
}

async function resolveWebApplyGroupId(windowId, tabId) {
  let groupId = webApplyGroupByWindow.get(windowId) ?? null;

  if (groupId != null) {
    const tabs = await chrome.tabs.query({ groupId }).catch(() => []);

    if (tabs.length) {
      trackJobMateGroupTab(groupId, tabId);
      return groupId;
    }

    webApplyGroupByWindow.delete(windowId);
    jobMateGroupTabs.delete(groupId);
  }

  groupId = await withTabEditRetry(() => chrome.tabs.group({ tabIds: [tabId] }));

  if (groupId != null) {
    await withTabEditRetry(() => chrome.tabGroups.update(groupId, { title: "JobMate Apply", color: "green" }));
    webApplyGroupByWindow.set(windowId, groupId);
    trackJobMateGroupTab(groupId, tabId);
  }

  return groupId;
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

const VISION_OCR_MODEL = "gemini-3.1-flash-lite";
const VISION_OCR_MAX_WIDTH = 800;
const VISION_OCR_JPEG_QUALITY = 0.8;

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function prepareVisionScreenshot(screenshotBase64) {
  const bytes = base64ToBytes(screenshotBase64);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width > VISION_OCR_MAX_WIDTH ? VISION_OCR_MAX_WIDTH / bitmap.width : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const captureWidth = bitmap.width;
  const captureHeight = bitmap.height;
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: VISION_OCR_JPEG_QUALITY });
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  return { base64: bytesToBase64(outBytes), width, height, captureWidth, captureHeight };
}

function visionBlocksFromModel(rawBlocks) {
  const out = [];
  if (!Array.isArray(rawBlocks)) return out;
  for (const item of rawBlocks) {
    const text = String(item?.text ?? "").trim();
    const x0 = Number(item?.x0);
    const y0 = Number(item?.y0);
    const x1 = Number(item?.x1);
    const y1 = Number(item?.y1);
    if (!text) continue;
    if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) continue;
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({
      text: text.slice(0, 200),
      x0: Math.max(0, Math.min(1000, Math.round(x0))),
      y0: Math.max(0, Math.min(1000, Math.round(y0))),
      x1: Math.max(0, Math.min(1000, Math.round(x1))),
      y1: Math.max(0, Math.min(1000, Math.round(y1)))
    });
  }
  return out.slice(0, 200);
}

async function performVisionOcrExt(apiKey, screenshotBase64) {
  const prompt = [
    "Extract every visible text region from this screenshot.",
    'Return exactly: {"blocks":[{"text":"","x0":0,"y0":0,"x1":0,"y1":0}]}',
    "Use normalized coordinates from 0 to 1000 where 0,0 is the top-left of the image and 1000,1000 is the bottom-right.",
    "x0,y0 is the top-left corner of the text box; x1,y1 is the bottom-right corner.",
    "Include buttons, links, labels, headings, and form field labels.",
    "Preserve the original language and spelling of each text region."
  ].join("\n\n");

  const raw = await callGeminiRouter(
    apiKey,
    VISION_OCR_MODEL,
    [
      { text: prompt },
      { inline_data: { mime_type: "image/jpeg", data: screenshotBase64 } }
    ],
    true
  );
  const parsed = parseJsonObjectExt(raw);
  const blocks = visionBlocksFromModel(parsed.blocks);
  if (!blocks.length) throw new Error("Vision OCR returned no text blocks.");
  return blocks;
}

function ocrBlockCenterFromBlock(block) {
  return {
    x: Math.round((Number(block.x0) + Number(block.x1)) / 2),
    y: Math.round((Number(block.y0) + Number(block.y1)) / 2)
  };
}

async function pickOcrBlockForTextExt(tabId, apiKey, targetText, fieldLabel, viewport) {
  const screenshotBase64 = await captureTabScreenshot(tabId);
  const prepared = await prepareVisionScreenshot(screenshotBase64);
  const ocrBlocks = await performVisionOcrExt(apiKey, prepared.base64);
  const blockLines = ocrBlocks
    .map((block, index) => `${index}: "${String(block.text || "").slice(0, 80)}"`)
    .join("\n");
  const prompt = [
    "Pick the OCR text block that matches the dropdown menu option to select.",
    'Return exactly: {"blockIndex":null,"reasoning":""}',
    `Target option: ${targetText}`,
    fieldLabel ? `Field: ${fieldLabel}` : "",
    `OCR_BLOCKS:\n${blockLines}`
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await callGeminiRouter(apiKey, VISION_OCR_MODEL, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const idx = Number(parsed.blockIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= ocrBlocks.length) {
    throw new Error("No OCR block matched the dropdown option.");
  }
  const block = ocrBlocks[idx];
  return {
    ok: true,
    coords: ocrBlockCenterFromBlock(block),
    ocrBlock: block,
    clickLayout: {
      viewportWidth: Number(viewport?.width) || 0,
      viewportHeight: Number(viewport?.height) || 0,
      scrollX: Number(viewport?.scrollX) || 0,
      scrollY: Number(viewport?.scrollY) || 0,
      captureWidth: prepared.captureWidth,
      captureHeight: prepared.captureHeight
    }
  };
}

async function getTabViewport(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ width: window.innerWidth, height: window.innerHeight })
  });
  const frame = results?.[0]?.result;
  const width = Number(frame?.width);
  const height = Number(frame?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Could not read tab viewport.");
  }
  return { width, height };
}

async function dispatchCdpMouseClick(tabId, x, y) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    pointerType: "mouse"
  });
  await sleep(40);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse"
  });
  await sleep(60);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse"
  });
}

async function clickAtCoordinates(tabId, coords, viewport, clientPoint) {
  if (!(await ensureDebuggerAttached(tabId))) {
    return { ok: false, error: "debugger_not_attached" };
  }
  let x;
  let y;
  if (clientPoint && Number.isFinite(Number(clientPoint.x)) && Number.isFinite(Number(clientPoint.y))) {
    x = Number(clientPoint.x);
    y = Number(clientPoint.y);
  } else {
    const normX = Number(coords?.x);
    const normY = Number(coords?.y);
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (!Number.isFinite(normX) || !Number.isFinite(normY) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return { ok: false, error: "invalid_coords" };
    }
    x = (normX / 1000) * width;
    y = (normY / 1000) * height;
  }
  try {
    await dispatchCdpMouseClick(tabId, x, y);
    await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {});
    const loc = await chrome.debugger.sendCommand({ tabId }, "DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true
    });
    if (loc?.backendNodeId) {
      const nodeClick = await clickElementByBackendNodeId(tabId, loc.backendNodeId);
      if (nodeClick.ok) return { ok: true, x, y };
    }
    return { ok: true, x, y };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const A11Y_INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox",
  "radio", "checkbox", "switch", "menuitem", "tab", "spinbutton", "slider",
  "menuitemcheckbox", "menuitemradio", "option"
]);

const A11Y_ACTION_ROLES = new Set([
  "button", "link", "menuitem", "tab", "menuitemcheckbox", "menuitemradio"
]);

const debuggerAttachedTabs = new Set();
const networkObservationsByTab = new Map();
const NETWORK_OBSERVATION_LIMIT = 40;

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttachedTabs.delete(source.tabId);
    networkObservationsByTab.delete(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === "Network.requestWillBeSent") {
    const entry = params.request || {};
    const resourceType = params.type || "";
    if (resourceType !== "XHR" && resourceType !== "Fetch") return;
    let track = networkObservationsByTab.get(tabId);
    if (!track) {
      track = [];
      networkObservationsByTab.set(tabId, track);
    }
    track.push({
      requestId: params.requestId,
      method: entry.method || "GET",
      url: entry.url || "",
      resourceType,
      status: null,
      mimeType: null,
      timestamp: Date.now()
    });
    if (track.length > NETWORK_OBSERVATION_LIMIT) track.shift();
    return;
  }
  if (method === "Network.responseReceived") {
    const track = networkObservationsByTab.get(tabId);
    if (!track) return;
    const response = params.response || {};
    const mimeType = String(response.mimeType || "");
    const item = track.find((t) => t.requestId === params.requestId);
    if (!item) return;
    item.status = response.status;
    item.mimeType = mimeType;
  }
});

function getNetworkObservations(tabId) {
  const track = networkObservationsByTab.get(tabId) || [];
  return track.filter((item) => {
    const mime = String(item.mimeType || "");
    return mime.includes("json") || item.resourceType === "XHR" || item.resourceType === "Fetch";
  });
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerAttachedTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttachedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function detachDebuggerTab(tabId) {
  if (!debuggerAttachedTabs.has(tabId)) return;
  debuggerAttachedTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => { });
}

function backendNodeIdFromElementId(elementId) {
  const raw = String(elementId || "");
  if (!raw.startsWith("ax_")) return null;
  const parsed = Number(raw.slice(3));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function clickElementByBackendNodeId(tabId, backendNodeId) {
  if (!(await ensureDebuggerAttached(tabId))) {
    return { ok: false, error: "debugger_not_attached" };
  }
  const nodeId = Number(backendNodeId);
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return { ok: false, error: "invalid_backend_node_id" };
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {});
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
    const { object } = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { backendNodeId: nodeId });
    if (!object?.objectId) return { ok: false, error: "resolve_failed" };

    const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() {
        let el = this;
        while (el) {
          if (el.disabled || el.getAttribute?.("aria-disabled") === "true") return { ok: false, reason: "disabled" };
          const tag = (el.tagName || "").toLowerCase();
          const role = el.getAttribute?.("role") || "";
          const inputType = tag === "input" ? (el.type || "").toLowerCase() : "";
          const interactive =
            tag === "button" ||
            tag === "a" ||
            tag === "label" ||
            role === "button" ||
            role === "link" ||
            role === "tab" ||
            inputType === "submit" ||
            inputType === "button" ||
            inputType === "checkbox" ||
            inputType === "radio";
          if (interactive) {
            if (tag === "a" && el.href) el.setAttribute("target", "_self");
            try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
            try { el.focus(); } catch {}
            try { el.click(); } catch (err) { return { ok: false, reason: String(err) }; }
            return { ok: true, href: el.href || null };
          }
          el = el.parentElement;
        }
        if (!this || !this.isConnected) return { ok: false, reason: "disconnected" };
        try { this.scrollIntoView({ block: "center", inline: "center" }); } catch {}
        try { this.focus(); } catch {}
        try { this.click(); } catch (err) { return { ok: false, reason: String(err) }; }
        return { ok: true, href: this.href || null };
      }`,
      returnByValue: true
    });

    const value = result?.value;
    if (value?.ok) return { ok: true, href: value.href || null };
    return { ok: false, error: value?.reason || "click_failed" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForDownloadComplete(downloadId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items?.[0];
    if (!item) throw new Error("Download entry missing.");
    if (item.state === "complete") return item;
    if (item.state === "interrupted") throw new Error("Download interrupted.");
    await sleep(120);
  }
  throw new Error("Download timed out.");
}

function safeDownloadFilename(filename) {
  const raw = String(filename || "_jobmate_resume.pdf");
  let safe = "";
  for (const char of raw) {
    safe += char === "/" || char === "\\" ? "_" : char;
  }
  return safe || "_jobmate_resume.pdf";
}

function resumeDataUrl(base64, mimeType) {
  const type = String(mimeType || "application/pdf");
  return `data:${type};base64,${base64}`;
}

async function writeTempResumeFile(base64, mimeType, filename) {
  const safeName = safeDownloadFilename(filename);
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: resumeDataUrl(base64, mimeType),
        filename: `JobMate/${safeName}`,
        conflictAction: "overwrite",
        saveAs: false
      },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      }
    );
  });
  if (!downloadId) throw new Error("Download id missing.");
  try {
    const item = await waitForDownloadComplete(downloadId);
    if (!item.filename) throw new Error("Download path missing.");
    return { downloadId, filePath: item.filename };
  } catch (err) {
    try {
      await removeDownloadEntry(downloadId);
    } catch (cleanupErr) {
      const original = err instanceof Error ? err.message : String(err);
      const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      throw new Error(`${original}; cleanup_temp_file failed: ${cleanup}`);
    }
    throw err;
  }
}

async function removeDownloadEntry(downloadId) {
  if (!downloadId) return;
  await chrome.downloads.removeFile(downloadId);
  await chrome.downloads.erase({ id: downloadId });
}

async function withTempDownloadCleanup(downloadId, diagnostic) {
  if (!downloadId) return diagnostic;
  try {
    await removeDownloadEntry(downloadId);
    return diagnostic;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stage: "cleanup_temp_file",
      fieldId: diagnostic.fieldId,
      backendNodeId: diagnostic.backendNodeId,
      fileCount: diagnostic.fileCount
    };
  }
}

async function fileInputCountViaCdp(tabId, objectId) {
  const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function() { return this.files ? this.files.length : 0; }",
    returnByValue: true
  });
  return Number(result?.value) || 0;
}

async function dispatchFileInputEventsViaCdp(tabId, objectId) {
  await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }`,
    returnByValue: true
  });
}

async function resolveFileInputTargetViaCdp(tabId, fieldId) {
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {});
  const fid = JSON.stringify(String(fieldId || ""));
  const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(function(){
      function queryDeep(selector, root) {
        const found = [];
        for (const node of root.querySelectorAll(selector)) found.push(node);
        for (const host of root.querySelectorAll("*")) {
          if (host.shadowRoot) {
            for (const node of queryDeep(selector, host.shadowRoot)) found.push(node);
          }
        }
        return found;
      }

      const mark = queryDeep('[data-jobmate-cdp-file-target="1"]', document)[0];
      if (mark) { mark.removeAttribute('data-jobmate-cdp-file-target'); return mark; }
      const fid = ${fid};
      if (fid) {
        const byId = queryDeep('[data-jobmate-field-id="' + CSS.escape(fid) + '"]', document)[0];
        if (byId) return byId;
      }
      return null;
    })()`,
    returnByValue: false
  });
  if (!result?.objectId) return null;
  const described = await chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", { objectId: result.objectId });
  const backendNodeId = described?.node?.backendNodeId ?? null;
  if (!backendNodeId) return null;
  return { objectId: result.objectId, backendNodeId };
}

async function setFileInputFilesViaCdp(tabId, fileInputTarget, filePath) {
  if (!fileInputTarget?.objectId) throw new Error("Could not resolve file input object.");
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    objectId: fileInputTarget.objectId,
    files: [filePath]
  });
  await dispatchFileInputEventsViaCdp(tabId, fileInputTarget.objectId);
  return { ok: true, fileCount: null };
}

async function cdpSetFileOnTab(tabId, { base64, mimeType, filename, fieldId, clientX, clientY }) {
  if (!(await ensureDebuggerAttached(tabId))) {
    return { ok: false, error: "debugger_not_attached", stage: "debugger_attach", fieldId: fieldId || "", backendNodeId: null, fileCount: null };
  }
  if (!base64) return { ok: false, error: "missing_file_data", stage: "validate_file", fieldId: fieldId || "", backendNodeId: null, fileCount: null };
  let downloadId = null;
  let backendNodeId = null;
  let fileCount = null;
  let stage = "resolve_file_input";
  try {
    const fileInputTarget = await resolveFileInputTargetViaCdp(tabId, fieldId);
    backendNodeId = fileInputTarget?.backendNodeId ?? null;
    if (!fileInputTarget) {
      return { ok: false, error: "file_input_not_found", stage: "resolve_file_input", fieldId: fieldId || "", backendNodeId: null, fileCount: null };
    }
    stage = "write_temp_file";
    const temp = await writeTempResumeFile(base64, mimeType, filename);
    downloadId = temp.downloadId;
    const filePath = temp.filePath;
    stage = "set_file_input_files";
    const direct = await setFileInputFilesViaCdp(tabId, fileInputTarget, filePath);
    fileCount = direct.fileCount;
    return await withTempDownloadCleanup(downloadId, { ok: true, error: null, stage: "set_file_input_files", fieldId: fieldId || "", backendNodeId, fileCount: direct.fileCount });
  } catch (err) {
    return await withTempDownloadCleanup(downloadId, { ok: false, error: err instanceof Error ? err.message : String(err), stage, fieldId: fieldId || "", backendNodeId, fileCount });
  }
}

async function cdpInsertTextOnTab(tabId, text) {
  if (!(await ensureDebuggerAttached(tabId))) {
    return { ok: false, error: "debugger_not_attached" };
  }
  const value = String(text ?? "");
  if (!value) return { ok: true };
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function cdpKeyDescriptor(key) {
  const value = String(key || "");
  if (value === "ArrowDown") return { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
  if (value === "ArrowUp") return { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 };
  if (value === "Enter") return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  if (value === "Tab") return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
  throw new Error(`Unsupported key: ${value}`);
}

async function cdpDispatchKeysOnTab(tabId, keys) {
  if (!(await ensureDebuggerAttached(tabId))) {
    return { ok: false, error: "debugger_not_attached" };
  }
  const list = Array.isArray(keys) ? keys : [];
  if (!list.length) return { ok: false, error: "missing_keys" };
  try {
    for (const key of list) {
      const descriptor = cdpKeyDescriptor(key);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode
      });
      await sleep(80);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pickSuggestionOptionExt(apiKey, model, fieldLabel, desiredAnswer, options) {
  const lines = options
    .map((option) => `${option.index}: "${String(option.text || "").slice(0, 120)}"`)
    .join("\n");
  const prompt = [
    "Pick the suggestion list option that best matches the desired value for a combobox or autocomplete field.",
    'Return exactly: {"optionIndex":null,"manualEntry":false,"typeAsFreeText":false,"reasoning":""}',
    "optionIndex is the candidate index to click, or null when no option fits.",
    "manualEntry is true when a manual or custom entry option should be selected before typing free text.",
    "typeAsFreeText is true when the typed value should remain without selecting a list option.",
    `Field label: ${fieldLabel}`,
    `Desired value: ${desiredAnswer}`,
    `Options:\n${lines}`
  ].join("\n\n");
  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  if (parsed.typeAsFreeText === true) {
    return { ok: true, typeAsFreeText: true, manualEntry: false, optionIndex: null };
  }
  if (parsed.manualEntry === true) {
    const idx = Number(parsed.optionIndex);
    return {
      ok: true,
      manualEntry: true,
      typeAsFreeText: false,
      optionIndex: Number.isFinite(idx) ? idx : null
    };
  }
  const idx = Number(parsed.optionIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) {
    throw new Error("No suggestion option matched.");
  }
  return { ok: true, manualEntry: false, typeAsFreeText: false, optionIndex: idx };
}

function axPropValue(node, name) {
  const prop = (node.properties || []).find((p) => p.name === name);
  return prop?.value?.value;
}

async function getInteractiveA11yActions(tabId, opts = {}) {
  const pageUrl = opts.pageUrl || "";
  const applyAnchorUrls = Array.isArray(opts.applyAnchorUrls) ? opts.applyAnchorUrls.filter(Boolean) : [];
  const leftListing = Boolean(opts.leftListing);
  const targetApplyUrl = opts.targetApplyUrl || "";
  const blockedIds = opts.blockedIds instanceof Set ? opts.blockedIds : new Set(opts.blockedIds || []);

  if (!(await ensureDebuggerAttached(tabId))) return [];

  try {
    const { nodes } = await chrome.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree");
    const actions = [];

    for (const node of nodes) {
      const role = node.role?.value;
      if (!role || !A11Y_ACTION_ROLES.has(role)) continue;
      let name = String(node.name?.value || "").trim();
      if (!name) name = String(axPropValue(node, "description") || "").trim();
      if (!name) name = String(node.value?.value || "").trim();
      if (!name) continue;
      if (axPropValue(node, "disabled") === true) continue;

      const backendNodeId = node.backendDOMNodeId;
      if (!backendNodeId) continue;

      const urlRaw = axPropValue(node, "url");
      const url = urlRaw ? String(urlRaw) : "";
      const elementId = `ax_${backendNodeId}`;
      if (blockedIds.has(elementId)) continue;

      if (url && pageUrl) {
        if (applyAnchorUrls.length && isOffTargetJobUrl(url, applyAnchorUrls, pageUrl)) continue;
        if (leftListing && targetApplyUrl && isReturnToListingUrl(url, targetApplyUrl, pageUrl)) continue;
      }

      actions.push({
        elementId,
        type: "action",
        role,
        tag: role,
        text: name.slice(0, 120),
        name: name.slice(0, 120),
        href: url,
        url,
        backendNodeId,
        disabled: false
      });
    }

    return prioritizeA11yActions(actions, applyAnchorUrls, pageUrl);
  } catch {
    return [];
  }
}

async function getA11ySnapshot(tabId) {
  const actions = await getInteractiveA11yActions(tabId);
  if (!actions.length) return null;
  return actions
    .slice(0, 80)
    .map((a) => {
      let line = `[${a.role}] "${a.text}"`;
      if (a.href) line += ` url:"${a.href.slice(0, 120)}"`;
      return line;
    })
    .join("\n");
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
    "Use correct spelling and diacritics for the target language.",
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
    return raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch { return ""; }
}

function buildFormAnswerPrompt(fields, ctx) {
  const { hasPdf, coverLetterText, contextBlock, writingSample, listingText, retryNote, chunkIndex, chunkTotal } = ctx;
  const requiredFieldSummary = fields
    .filter((f) => f.required)
    .map((f) => `fieldId="${f.fieldId}" label="${f.label}" type=${f.type}${f.options?.length ? ` options=${JSON.stringify(f.options.slice(0, 8))}` : ""}`)
    .join("\n");

  return [
    "You are filling a job application form.",
    "Return exactly one answer per fieldId in Fields JSON.",
    chunkTotal > 1 ? `This is chunk ${chunkIndex + 1} of ${chunkTotal}. Answer ONLY the fields in Fields JSON.` : "",
    "Read each field label, type, and options literally.",
    "Required fields must be non-empty.",
    "For select, radio, and checkbox fields, return the exact text of one listed option.",
    "For fields with needsSuggestionPick or fieldKind suggestion, return the exact visible label the form expects (city, country, etc.) in the form language.",
    "For file fields: resume/CV upload → \"__resume__\"; cover letter upload → \"__cover_letter__\"; otherwise empty string.",
    hasPdf
      ? "Use candidate context, listing, and attached resume PDF."
      : "Use candidate context and listing.",
    "Return valid JSON only: {\"answers\":[{\"fieldId\":\"\",\"answer\":\"\",\"reasoning\":\"\"}]}",
    requiredFieldSummary ? `REQUIRED FIELDS:\n${requiredFieldSummary}` : "",
    retryNote ? `RETRY:\n${retryNote}` : "",
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
    "Classify file upload fields by label and context.",
    "Return resumeFieldIds and coverLetterFieldIds.",
    "The same fieldId must never appear in both arrays.",
    "Return JSON only: {\"resumeFieldIds\":[],\"coverLetterFieldIds\":[]}",
    `File fields:\n${JSON.stringify(fileFields.map((f) => ({ fieldId: f.fieldId, label: f.label, context: f.context || "" })))}`,
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

async function extractRecordsExt(tabId, pageLanguage) {
  const config = await getExtensionConfig();
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) throw new Error("No Gemini API key configured.");
  const model = resolveAgentModel(config);
  const session = getApplySession(tabId);
  const payloadUrl = session?.payloadUrl ?? "";
  const jobData = payloadUrl ? (internalSessionJobData.get(payloadUrl) ?? {}) : {};
  const contextBlock = config.contextBlock || "";
  const hasPdf = Boolean(config.resumePdfBase64);
  const lang = pageLanguage?.trim().toLowerCase() || "";

  const prompt = [
    "Extract structured work experience and education entries from the candidate resume and context.",
    "Return only entries that appear in the resume or candidate context. Do not invent employers, schools, dates, or titles.",
    lang && lang !== "en" ? `Keep original language for titles and names when they appear in the resume. Language code: ${lang}.` : "",
    "Each experience entry should include: title, company, location, startMonth, startYear, endMonth, endYear, current (boolean), description.",
    "Each education entry should include: school, degree, fieldOfStudy, location, startMonth, startYear, endMonth, endYear, current (boolean), description.",
    "Use empty strings for unknown month/year values. Use current=true when the candidate still holds the role or is still enrolled.",
    "Order entries from most recent to oldest.",
    "Return JSON only: {\"experience\":[{\"title\":\"\",\"company\":\"\",\"location\":\"\",\"startMonth\":\"\",\"startYear\":\"\",\"endMonth\":\"\",\"endYear\":\"\",\"current\":false,\"description\":\"\"}],\"education\":[{\"school\":\"\",\"degree\":\"\",\"fieldOfStudy\":\"\",\"location\":\"\",\"startMonth\":\"\",\"startYear\":\"\",\"endMonth\":\"\",\"endYear\":\"\",\"current\":false,\"description\":\"\"}]}",
    contextBlock ? `Candidate context:\n${contextBlock}` : "",
    jobData.listingText ? `Job listing:\n${String(jobData.listingText).slice(0, 4000)}` : ""
  ].filter(Boolean).join("\n\n");

  const parts = [{ text: prompt }];
  if (hasPdf && config.resumePdfBase64) {
    parts.push({ inline_data: { mime_type: config.resumePdfMimeType || "application/pdf", data: config.resumePdfBase64 } });
  }

  const raw = await callGeminiExt(parts, apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);
  const experience = Array.isArray(parsed.experience) ? parsed.experience : [];
  const education = Array.isArray(parsed.education) ? parsed.education : [];
  return { ok: true, experience, education };
}

async function detectRepeatableSectionsExt(apiKey, model, sections, contextBlock, pageLanguage) {
  if (!sections.length) return { ok: true, sections: [] };
  const valid = new Set(sections.map((s) => s.sectionId));
  const lang = pageLanguage?.trim().toLowerCase() || "";
  const prompt = [
    "Identify repeatable form sections for work experience or education.",
    "Read section titles and button labels.",
    "recordType must be exactly one of: experience, education, other.",
    "addButtonText must exactly match one button text from that section's buttons array.",
    "Return JSON only: {\"sections\":[{\"sectionId\":\"\",\"recordType\":\"experience|education|other\",\"addButtonText\":\"\"}]}",
    `Sections JSON:\n${JSON.stringify(sections)}`,
    contextBlock ? `Candidate context:\n${contextBlock.slice(0, 2000)}` : ""
  ].filter(Boolean).join("\n\n");
  const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);
  const out = [];
  for (const item of parsed.sections ?? []) {
    const sectionId = String(item.sectionId ?? "");
    if (!valid.has(sectionId)) continue;
    const recordType = String(item.recordType ?? "other");
    if (!["experience", "education", "other"].includes(recordType)) continue;
    const addButtonText = String(item.addButtonText ?? "").trim();
    if (!addButtonText) continue;
    out.push({ sectionId, recordType, addButtonText });
  }
  return { ok: true, sections: out };
}

async function mapRecordFieldsExt(apiKey, model, recordType, record, fields, contextBlock, pageLanguage, actionButtons) {
  if (!fields.length) return { ok: true, answers: [], saveButtonText: "", cancelButtonText: "" };
  const validFieldIds = new Set(fields.map((f) => f.fieldId));
  const lang = pageLanguage?.trim().toLowerCase() || "";
  const buttons = Array.isArray(actionButtons) ? actionButtons.filter(Boolean) : [];
  const prompt = [
    "Map one resume record entry onto the fields of an inline add-record sub-form.",
    `Record type: ${recordType}.`,
    lang && lang !== "en" ? `Form language code: ${lang}. Match dropdown/autocomplete values to visible form language when possible.` : "",
    "Return one answer per fieldId in Fields JSON.",
    "Use empty string when the field does not apply to this record.",
    "For checkbox fields about currently working or currently enrolled, return the exact checkbox label text to select, or empty string for unchecked.",
    "For date/month/year fields, return values in the format the field label implies.",
    "saveButtonText and cancelButtonText must exactly match one of the visible action button labels listed below when present.",
    "Return JSON only: {\"answers\":[{\"fieldId\":\"\",\"answer\":\"\"}],\"saveButtonText\":\"\",\"cancelButtonText\":\"\"}",
    buttons.length ? `Visible action buttons:\n${JSON.stringify(buttons)}` : "",
    `Record JSON:\n${JSON.stringify(record)}`,
    `Fields JSON:\n${JSON.stringify(fields)}`,
    contextBlock ? `Candidate context:\n${contextBlock.slice(0, 2000)}` : ""
  ].filter(Boolean).join("\n\n");
  const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
  const parsed = parseJsonObjectExt(raw);
  const answers = (parsed.answers ?? [])
    .map((item) => ({ fieldId: String(item.fieldId ?? ""), answer: String(item.answer ?? "") }))
    .filter((item) => validFieldIds.has(item.fieldId));
  for (const field of fields) {
    if (answers.some((item) => item.fieldId === field.fieldId)) continue;
    answers.push({ fieldId: field.fieldId, answer: "" });
  }
  return {
    ok: true,
    answers,
    saveButtonText: String(parsed.saveButtonText ?? "").trim(),
    cancelButtonText: String(parsed.cancelButtonText ?? "").trim()
  };
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

function resolveRouterCheapModel(config) {
  const user = config.geminiModel?.trim();
  if (user) return user;
  return ROUTER_CHEAP_MODEL;
}

async function nextBrowserActionExt(tabId, pageData) {
  const config = await getExtensionConfig();
  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) throw new Error("No Gemini API key configured.");
  const cheapModel = resolveRouterCheapModel(config);
  const jobData = getSessionJobData(tabId);

  const { pageUrl, pageText, stepIndex, history, hiddenApplyUrl, elements, blockedElementIds, hasLeftTargetListing } = pageData;
  const blockedIds = new Set(Array.isArray(blockedElementIds) ? blockedElementIds.map(String) : []);

  const targetApplyUrl = jobData.applyUrl || pageUrl;
  const targetTitle = jobData.title || "";
  const targetCompany = jobData.company || "";
  const applyAnchorUrls = [targetApplyUrl, hiddenApplyUrl].filter(Boolean);
  const leftListing = Boolean(hasLeftTargetListing);

  const viewport = pageData.viewport && Number(pageData.viewport.width) > 0 && Number(pageData.viewport.height) > 0
    ? {
        width: Number(pageData.viewport.width),
        height: Number(pageData.viewport.height),
        scrollX: Number(pageData.viewport.scrollX) || 0,
        scrollY: Number(pageData.viewport.scrollY) || 0
      }
    : await getTabViewport(tabId);

  const screenshotPromise = captureTabScreenshot(tabId);
  const axActionsPromise = getInteractiveA11yActions(tabId, {
    pageUrl,
    applyAnchorUrls,
    leftListing,
    targetApplyUrl,
    blockedIds
  });

  const [screenshotBase64, axActionsRaw] = await Promise.all([screenshotPromise, axActionsPromise]);
  const prepared = await prepareVisionScreenshot(screenshotBase64);
  const ocrBlocks = await performVisionOcrExt(apiKey, prepared.base64);

  const domActions = (elements || []).filter((e) => e.type === "action");
  const mergedActionsRaw = [...axActionsRaw];
  const seenActionKeys = new Set(
    axActionsRaw.map((a) => `${String(a.role || a.tag || "").toLowerCase()}:${String(a.text || a.name || "").toLowerCase().trim()}`)
  );
  for (const dom of domActions) {
    const key = `${String(dom.role || dom.tag || "").toLowerCase()}:${String(dom.text || dom.name || "").toLowerCase().trim()}`;
    if (!key.endsWith(":") && seenActionKeys.has(key)) continue;
    seenActionKeys.add(key);
    mergedActionsRaw.push({
      elementId: dom.elementId,
      type: "action",
      role: dom.role || dom.tag,
      tag: dom.tag,
      text: dom.text,
      name: dom.text || dom.name,
      href: dom.href || "",
      url: dom.href || ""
    });
  }
  const actions = mergedActionsRaw.filter((e) => !blockedIds.has(e.elementId));

  const observation = buildPageObservation({
    tabId,
    pageUrl,
    pageText,
    stepIndex,
    history,
    hiddenApplyUrl,
    elements,
    blockedElementIds,
    hasLeftTargetListing,
    targetApplyUrl,
    targetTitle,
    targetCompany,
    actions,
    allActions: mergedActionsRaw,
    networkObservations: getNetworkObservations(tabId),
    ocrBlocks,
    viewport,
    ocrImageSize: { width: prepared.width, height: prepared.height },
    captureSize: { width: prepared.captureWidth, height: prepared.captureHeight }
  });

  const semanticMemoryResolve = (obs, rankedIds) =>
    resolveFromSemanticMemory(apiKey, cheapModel, obs, rankedIds);

  try {
    return await routeBrowserAction(apiKey, cheapModel, observation, semanticMemoryResolve);
  } catch (err) {
    return packRouterAnalyzeResponse(
      observation,
      {
        tool: "blocked",
        elementId: null,
        url: null,
        text: null,
        value: null,
        reasoning: err instanceof Error ? err.message : String(err),
        coverLetterElementIds: [],
        coverLetterRevealIds: [],
        resumeElementIds: []
      },
      []
    );
  }
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
  await untrackJobMateGroupTab(tabId);

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
  await ensureDebuggerAttached(tabId);
  await withTabEditRetry(() => chrome.tabs.update(tabId, { active: false }));
}

async function openApplyAutomationTab(url, payloadUrl, uiTabId, groupId = null) {
  const existingId = applyAutomationTabByPayload.get(payloadUrl);

  if (existingId) {
    const existing = await chrome.tabs.get(existingId).catch(() => null);

    if (existing?.id) {
      applyAutomationTabByPayload.set(payloadUrl, existingId);
      setApplySession(existingId, payloadUrl, uiTabId);
      await ensureDebuggerAttached(existingId);
      await withTabEditRetry(() => chrome.tabs.update(existingId, { url, active: false }));
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
  await ensureDebuggerAttached(tabId);
  await withTabEditRetry(() => chrome.tabs.update(tabId, { active: false }));

  if (groupId != null) {
    await addTabToGroup(tabId, groupId);
  } else {
    await resolveWebApplyGroupId(created.windowId, tabId);
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
  void withTabEditRetry(() => chrome.tabs.remove(openerId));
  void withTabEditRetry(() => chrome.tabs.update(tabId, { active: false }));
});

async function createIsolatedCrawlerTab(initialUrl = "about:blank") {
  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  if (!tab?.id) throw new Error("Failed to create crawler tab.");

  const groupId = await withTabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id] }));

  if (groupId != null) {
    await withTabEditRetry(() =>
      chrome.tabGroups.update(groupId, { title: "JobMate Crawl", color: "grey", collapsed: true })
    );
    trackJobMateGroupTab(groupId, tab.id);
  }

  return { tabId: tab.id, windowId: tab.windowId, groupId };
}

async function closeIsolatedCrawlerWindow(windowId, tabId) {
  if (tabId != null) {
    await withTabEditRetry(() => chrome.tabs.remove(tabId));
    await untrackJobMateGroupTab(tabId);
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

  if (msg?.type === "JOBMATE_RECORD_SEMANTIC_MEMORY") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) {
          sendResponse({ ok: false, error: "No Gemini API key configured." });
          return;
        }
        const cheapModel = resolveRouterCheapModel(config);
        const pageUrl = String(msg.pageUrl || "");
        const fieldCount = Number(msg.fieldCount) || 0;
        const tool = String(msg.tool || "");
        const element = msg.element || null;
        const navigateUrl = msg.navigateUrl || null;
        const pageText = String(msg.pageText || "");
        const phase = fieldCount >= 8 ? "application_form" : tool === "navigate" ? "pre_apply" : "application_form";
        await recordSemanticMemoryStep(apiKey, cheapModel, pageUrl, phase, fieldCount, tool, element, navigateUrl, pageText);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
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
    (async () => {
      const tabId = sender.tab?.id;
      const session = tabId ? getApplySession(tabId) : null;
      const payloadUrl = session?.payloadUrl ?? "";

      if (tabId) {
        applySessionByTabId.delete(tabId);
        await detachDebuggerTab(tabId);
      }

      if (payloadUrl) {
        applyAutomationTabByPayload.delete(payloadUrl);
      }

      sendResponse({ ok: true });
    })();
    return true;
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

  if (msg?.type === "JOBMATE_EXTRACT_RECORDS") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      const pageLanguage = typeof msg.pageLanguage === "string" ? msg.pageLanguage : "";
      try {
        sendResponse(await extractRecordsExt(tabId, pageLanguage));
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_DETECT_REPEATABLE_SECTIONS") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key." }); return; }
        const model = resolveAgentModel(config);
        const sections = Array.isArray(msg.sections) ? msg.sections : [];
        const pageLanguage = typeof msg.pageLanguage === "string" ? msg.pageLanguage : "";
        sendResponse(await detectRepeatableSectionsExt(apiKey, model, sections, config.contextBlock || "", pageLanguage));
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_MAP_RECORD_FIELDS") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key." }); return; }
        const model = resolveAgentModel(config);
        const fields = Array.isArray(msg.fields) ? msg.fields : [];
        const record = msg.record && typeof msg.record === "object" ? msg.record : {};
        const recordType = typeof msg.recordType === "string" ? msg.recordType : "other";
        const pageLanguage = typeof msg.pageLanguage === "string" ? msg.pageLanguage : "";
        const actionButtons = Array.isArray(msg.actionButtons) ? msg.actionButtons : [];
        sendResponse(await mapRecordFieldsExt(apiKey, model, recordType, record, fields, config.contextBlock || "", pageLanguage, actionButtons));
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_EXPLAIN_REFUSAL") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key." }); return; }
        const model = resolveAgentModel(config);
        const fields = Array.isArray(msg.fields) ? msg.fields : [];
        const givenAnswers = Array.isArray(msg.answers) ? msg.answers : [];

        const fieldLines = fields.map((f) => {
          const given = givenAnswers.find((a) => a.fieldId === f.fieldId)?.answer ?? "";
          return `fieldId="${f.fieldId}" label="${f.label}" type=${f.type}${f.options?.length ? ` options=${JSON.stringify(f.options.slice(0, 8))}` : ""}\nAnswer you gave: ${JSON.stringify(given)}`;
        }).join("\n\n");

        const prompt = [
          "You filled a job application form and the following required fields were left blank.",
          "This is a mandatory accounting. For each field, you must state exactly:",
          "1. What specific information you could not find in the candidate context.",
          "2. Precisely where in the candidate context you looked for it.",
          "3. Why you could not derive any reasonable answer from what was available.",
          "Leaving a required field blank is not permitted. If you did, you must name exactly what was absent.",
          `Candidate context:\n${config.contextBlock || ""}`,
          `Required fields left blank:\n${fieldLines}`,
          'Return JSON: {"explanations":[{"fieldId":"","label":"","reason":""}]}'
        ].filter(Boolean).join("\n\n");

        const raw = await callGeminiExt([{ text: prompt }], apiKey, model, true);
        const parsed = parseJsonObjectExt(raw);
        const items = Array.isArray(parsed.explanations) ? parsed.explanations : [];

        const lines = fields.map((f) => {
          const exp = items.find((i) => String(i.fieldId ?? "") === f.fieldId);
          return `"${f.label}": ${exp?.reason || "no explanation returned"}`;
        });

        sendResponse({ ok: true, lines });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
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

  if (msg?.type === "JOBMATE_OCR_PICK_TEXT") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key configured." }); return; }
        const targetText = String(msg.targetText || "").trim();
        if (!targetText) { sendResponse({ ok: false, error: "No target text." }); return; }
        const fieldLabel = String(msg.fieldLabel || "").trim();
        const viewport = msg.viewport && Number(msg.viewport.width) > 0 && Number(msg.viewport.height) > 0
          ? {
              width: Number(msg.viewport.width),
              height: Number(msg.viewport.height),
              scrollX: Number(msg.viewport.scrollX) || 0,
              scrollY: Number(msg.viewport.scrollY) || 0
            }
          : await getTabViewport(tabId);
        const result = await pickOcrBlockForTextExt(tabId, apiKey, targetText, fieldLabel, viewport);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_CDP_CLICK") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      const backendNodeId = msg.backendNodeId ?? backendNodeIdFromElementId(msg.elementId);
      try {
        const result = await clickElementByBackendNodeId(tabId, backendNodeId);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_CDP_SET_FILE") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const result = await cdpSetFileOnTab(tabId, {
          base64: msg.base64,
          mimeType: msg.mimeType,
          filename: msg.filename,
          fieldId: msg.fieldId,
          clientX: msg.clientX,
          clientY: msg.clientY
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_CDP_INSERT_TEXT") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const result = await cdpInsertTextOnTab(tabId, msg.text);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_CDP_DISPATCH_KEYS") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const result = await cdpDispatchKeysOnTab(tabId, msg.keys);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_PICK_SUGGESTION_OPTION") {
    (async () => {
      try {
        const config = await getExtensionConfig();
        const apiKey = config.geminiApiKey?.trim();
        if (!apiKey) { sendResponse({ ok: false, error: "No Gemini API key configured." }); return; }
        const model = resolveRouterCheapModel(config);
        const fieldLabel = String(msg.fieldLabel || "").trim();
        const desiredAnswer = String(msg.desiredAnswer || "").trim();
        const options = Array.isArray(msg.options) ? msg.options : [];
        const result = await pickSuggestionOptionExt(apiKey, model, fieldLabel, desiredAnswer, options);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_COORD_CLICK") {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: "No tab." }); return; }
      try {
        const viewport = msg.viewport && Number(msg.viewport.width) > 0 && Number(msg.viewport.height) > 0
          ? { width: Number(msg.viewport.width), height: Number(msg.viewport.height) }
          : await getTabViewport(tabId);
        const clientPoint =
          Number.isFinite(Number(msg.clientX)) && Number.isFinite(Number(msg.clientY))
            ? { x: Number(msg.clientX), y: Number(msg.clientY) }
            : null;
        const result = await clickAtCoordinates(tabId, msg.coords, viewport, clientPoint);
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
        await detachDebuggerTab(tabId);
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
