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

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind || "";
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
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
  const badge = document.getElementById("config-badge");
  if (cfg.geminiApiKey) {
    badge.textContent = "Ready";
    badge.className = "badge";
  } else {
    badge.textContent = "No API key";
    badge.className = "badge warn";
  }
}

function clearResume() {
  storageSet({ resumePdfBase64: "", resumePdfFilename: "", resumePdfMimeType: "" });
  document.getElementById("resume-name").innerHTML = "";
  document.getElementById("s-resume").value = "";
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("save-status");
  setStatus(statusEl, "Saving…", "");

  const fileInput = document.getElementById("s-resume");
  const file = fileInput.files?.[0];

  let resumePdfBase64 = null;
  let resumePdfFilename = null;
  let resumePdfMimeType = null;

  if (file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      resumePdfBase64 = btoa(binary);
      resumePdfFilename = file.name;
      resumePdfMimeType = file.type || "application/pdf";
    } catch (err) {
      setStatus(statusEl, "Failed to read PDF: " + err.message, "error");
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
  setStatus(statusEl, "Saved.", "ok");
  setTimeout(() => setStatus(statusEl, "", ""), 2000);
});

const fillBtn = document.getElementById("fill-btn");
const fillStatus = document.getElementById("fill-status");

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  setStatus(fillStatus, "Starting…", "info");

  try {
    const cfg = await storageGet(["geminiApiKey"]);
    if (!cfg.geminiApiKey) {
      setStatus(fillStatus, "Add a Gemini API key in Settings first.", "error");
      fillBtn.disabled = false;
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) {
      setStatus(fillStatus, "Could not read current tab.", "error");
      fillBtn.disabled = false;
      return;
    }

    if (/^chrome:|^about:|^edge:/.test(tab.url)) {
      setStatus(fillStatus, "Cannot autofill browser system pages.", "error");
      fillBtn.disabled = false;
      return;
    }

    const resp = await chrome.runtime.sendMessage({
      type: "JOBMATE_ADHOC_FILL_REQUEST",
      pageTabId: tab.id,
      pageUrl: tab.url
    });

    if (resp?.ok) {
      setStatus(fillStatus, "Autofill started.", "ok");
      setTimeout(() => window.close(), 900);
    } else {
      setStatus(fillStatus, resp?.error || "Failed to start autofill.", "error");
      fillBtn.disabled = false;
    }
  } catch (err) {
    setStatus(fillStatus, err?.message || "Error.", "error");
    fillBtn.disabled = false;
  }
});

loadSettings();
