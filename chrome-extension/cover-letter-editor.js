const params = new URLSearchParams(location.search);
const sessionId = params.get("id") || "";
const draftEl = document.getElementById("draft");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const rejectBtn = document.getElementById("reject");

function setBusy(busy) {
  saveBtn.disabled = busy;
  rejectBtn.disabled = busy;
}

function finish(action, text) {
  setBusy(true);
  statusEl.textContent = action === "save" ? "Saving…" : "Skipping cover letter…";
  chrome.runtime.sendMessage(
    { type: "JOBMATE_COVER_LETTER_EDITOR_DONE", sessionId, action, text: text ?? "" },
    () => {
      window.close();
    }
  );
}

if (!sessionId) {
  statusEl.textContent = "Missing session. Close this tab and run apply again from JobMate.";
  saveBtn.disabled = true;
  rejectBtn.disabled = true;
} else {
  chrome.runtime.sendMessage({ type: "JOBMATE_COVER_LETTER_EDITOR_READY", sessionId }, (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = chrome.runtime.lastError.message;
      return;
    }
    if (!resp?.ok) {
      statusEl.textContent = resp?.error || "Could not load draft.";
      return;
    }
    draftEl.value = String(resp.draft || "");
    if (!draftEl.value.trim()) {
      statusEl.textContent = "Draft is empty — write or paste your letter, then Save.";
    }
  });
}

saveBtn.addEventListener("click", () => {
  const text = draftEl.value.trim();
  if (!text) {
    statusEl.textContent = "Cover letter is empty. Add text or click Reject.";
    return;
  }
  finish("save", text);
});

rejectBtn.addEventListener("click", () => finish("reject", ""));
