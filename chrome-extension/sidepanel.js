const STORAGE_KEYS = [
  "geminiApiKey", "geminiModel", "candidateName", "candidateEmail",
  "contextBlock", "writingSample", "coverLetterTemplate",
  "resumePdfBase64", "resumePdfFilename", "resumePdfMimeType"
];

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

let port = null;
const taskCards = new Map();
let pendingClarify = null;

function connectPort() {
  port = chrome.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener(handleBackgroundMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 1000);
  });
}

connectPort();

function handleBackgroundMessage(msg) {
  if (!msg?.type) return;

  if (msg.type === "TASKS_SNAPSHOT") {
    renderAllTasks(msg.tasks || []);
    return;
  }

  if (msg.type === "TASK_UPDATE") {
    upsertTaskCard(msg.task);
    return;
  }

  if (msg.type === "TASK_REMOVED") {
    const card = taskCards.get(msg.taskId);
    if (card) { card.remove(); taskCards.delete(msg.taskId); }
    maybeShowEmpty();
    return;
  }

  if (msg.type === "CLARIFY_REQUEST") {
    pendingClarify = msg;
    showClarify(msg.question);
    return;
  }

  if (msg.type === "CALLOUT") {
    showCallout(msg);
    return;
  }

  if (msg.type === "CALLOUT_CLEAR") {
    hideCallout();
    return;
  }
}

function sendToBackground(msg) {
  if (port) {
    try { port.postMessage(msg); return; } catch {}
  }
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function renderAllTasks(tasks) {
  const container = document.getElementById("tasks");
  const empty = document.getElementById("empty-state");
  taskCards.clear();
  for (const child of [...container.children]) {
    if (child !== empty) child.remove();
  }
  for (const task of tasks) upsertTaskCard(task);
  maybeShowEmpty();
}

function upsertTaskCard(task) {
  const container = document.getElementById("tasks");
  const empty = document.getElementById("empty-state");

  let card = taskCards.get(task.id);

  if (!card) {
    card = document.createElement("div");
    card.className = "task-card";
    card.dataset.taskId = task.id;
    container.insertBefore(card, empty);
    taskCards.set(task.id, card);
  }

  const steps = (task.steps || []).map((s) => {
    const cls = s.status === "active" ? "active" : s.status === "done" ? "done" : s.status === "error" ? "error" : "";
    return `<li class="task-step ${cls}">${escHtml(s.label)}</li>`;
  }).join("");

  const dotClass = task.status === "running" ? "running" : task.status === "done" ? "done" : task.status === "error" ? "error" : task.status === "waiting" ? "waiting" : "pending";

  const groupBadge = task.groupId
    ? `<div class="task-group-badge">Tab group #${task.groupId}</div>`
    : "";

  card.innerHTML = `
    <div class="task-header">
      <div class="task-status-dot ${dotClass}"></div>
      <div class="task-title">${escHtml(task.title)}</div>
      <button class="task-dismiss" data-task-id="${task.id}" title="Dismiss">✕</button>
    </div>
    <div class="task-status-text">${escHtml(task.statusText || "")}</div>
    ${steps ? `<ul class="task-steps">${steps}</ul>` : ""}
    ${groupBadge}
  `;

  card.querySelector(".task-dismiss")?.addEventListener("click", (e) => {
    const id = e.currentTarget.dataset.taskId;
    sendToBackground({ type: "TASK_DISMISS", taskId: id });
  });

  maybeShowEmpty();
}

function maybeShowEmpty() {
  const empty = document.getElementById("empty-state");
  empty.style.display = taskCards.size === 0 ? "flex" : "none";
}

function showCallout(msg) {
  const el = document.getElementById("callout");
  const label = document.getElementById("callout-label");
  const msgEl = document.getElementById("callout-msg");
  const instrEl = document.getElementById("callout-instruction");
  const inputEl = document.getElementById("callout-input");
  const btnEl = document.getElementById("callout-btn");

  el.className = "visible " + (msg.kind === "warn" ? "warn" : msg.kind === "info" ? "info" : "");
  label.textContent = msg.label || "Action needed";
  msgEl.textContent = msg.message || "";
  instrEl.textContent = msg.instruction || "";

  if (msg.hasInput) {
    inputEl.style.display = "";
    inputEl.value = "";
    inputEl.placeholder = msg.inputPlaceholder || "Type a reply…";
  } else {
    inputEl.style.display = "none";
  }

  btnEl.textContent = msg.buttonLabel || "Continue";
  btnEl.onclick = () => {
    const reply = msg.hasInput ? inputEl.value.trim() : null;
    sendToBackground({ type: "CALLOUT_REPLY", taskId: msg.taskId, reply });
    hideCallout();
  };
}

function hideCallout() {
  const el = document.getElementById("callout");
  el.className = "";
}

function showClarify(question) {
  const el = document.getElementById("clarify-question");
  el.textContent = question;
  el.classList.remove("hidden");
  document.getElementById("task-input").placeholder = "Answer the question above…";
  document.getElementById("task-input").focus();
}

function hideClarify() {
  document.getElementById("clarify-question").classList.add("hidden");
  document.getElementById("task-input").placeholder = "Apply to React jobs at fintech companies in Paris…";
}

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const taskInput = document.getElementById("task-input");
const sendBtn = document.getElementById("send-btn");

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitInput();
  }
});

taskInput.addEventListener("input", () => {
  taskInput.style.height = "auto";
  taskInput.style.height = Math.min(taskInput.scrollHeight, 120) + "px";
});

sendBtn.addEventListener("click", submitInput);

function submitInput() {
  const text = taskInput.value.trim();
  if (!text) return;
  taskInput.value = "";
  taskInput.style.height = "auto";

  if (pendingClarify) {
    sendToBackground({ type: "CLARIFY_REPLY", clarifyId: pendingClarify.clarifyId, reply: text });
    pendingClarify = null;
    hideClarify();
    return;
  }

  sendToBackground({ type: "TASK_SUBMIT", text });
}

document.getElementById("toggle-settings").addEventListener("click", () => {
  const panel = document.getElementById("settings-panel");
  const main = document.getElementById("main");
  const btn = document.getElementById("toggle-settings");
  const isOpen = panel.classList.toggle("visible");
  main.style.display = isOpen ? "none" : "flex";
  main.style.flexDirection = "column";
  main.style.flex = "1";
  main.style.overflow = "hidden";
  btn.textContent = isOpen ? "← Back" : "Settings";
  if (isOpen) loadSettings();
});

const keyToggle = document.getElementById("key-toggle");
const apikeyInput = document.getElementById("s-apikey");
keyToggle.addEventListener("click", () => {
  const isPassword = apikeyInput.type === "password";
  apikeyInput.type = isPassword ? "text" : "password";
  keyToggle.textContent = isPassword ? "Hide" : "Show";
});

async function loadSettings() {
  const cfg = await storageGet(STORAGE_KEYS);
  if (cfg.geminiApiKey) apikeyInput.value = cfg.geminiApiKey;
  if (cfg.geminiModel) document.getElementById("s-model").value = cfg.geminiModel;
  if (cfg.candidateName) document.getElementById("s-name").value = cfg.candidateName;
  if (cfg.candidateEmail) document.getElementById("s-email").value = cfg.candidateEmail;
  if (cfg.contextBlock) document.getElementById("s-context").value = cfg.contextBlock;
  if (cfg.writingSample) document.getElementById("s-sample").value = cfg.writingSample;
  if (cfg.coverLetterTemplate) document.getElementById("s-cltemplate").value = cfg.coverLetterTemplate;
  if (cfg.resumePdfFilename) {
    const el = document.getElementById("resume-name");
    el.innerHTML = `<span class="resume-name">${cfg.resumePdfFilename}</span><span class="resume-clear" id="resume-clear">✕ Remove</span>`;
    document.getElementById("resume-clear")?.addEventListener("click", clearResume);
  }
}

function clearResume() {
  storageSet({ resumePdfBase64: "", resumePdfFilename: "", resumePdfMimeType: "" });
  document.getElementById("resume-name").innerHTML = "";
  document.getElementById("s-resume").value = "";
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "Saving…"; statusEl.className = "";

  const file = document.getElementById("s-resume").files?.[0];
  let resumePdfBase64 = null, resumePdfFilename = null, resumePdfMimeType = null;

  if (file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      resumePdfBase64 = btoa(binary);
      resumePdfFilename = file.name;
      resumePdfMimeType = file.type || "application/pdf";
    } catch (err) {
      statusEl.textContent = "Failed to read PDF: " + err.message;
      statusEl.className = "error";
      return;
    }
  }

  const updates = {
    geminiApiKey: apikeyInput.value.trim(),
    geminiModel: document.getElementById("s-model").value.trim(),
    candidateName: document.getElementById("s-name").value.trim(),
    candidateEmail: document.getElementById("s-email").value.trim(),
    contextBlock: document.getElementById("s-context").value.trim(),
    writingSample: document.getElementById("s-sample").value.trim(),
    coverLetterTemplate: document.getElementById("s-cltemplate").value.trim()
  };
  if (resumePdfBase64 !== null) {
    updates.resumePdfBase64 = resumePdfBase64;
    updates.resumePdfFilename = resumePdfFilename;
    updates.resumePdfMimeType = resumePdfMimeType;
  }

  await storageSet(updates);
  await loadSettings();
  statusEl.textContent = "Saved."; statusEl.className = "ok";
  setTimeout(() => { statusEl.textContent = ""; }, 2000);
});

sendToBackground({ type: "SIDEPANEL_READY" });
