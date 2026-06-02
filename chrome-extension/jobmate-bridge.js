chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "JOBMATE_APPLY_ATTENTION") {
    window.postMessage(
      {
        source: "jobmate-extension",
        type: "JOBMATE_APPLY_ATTENTION",
        message: msg.message || "",
        instruction: msg.instruction || "",
        applyUrl: msg.applyUrl || "",
        kind: msg.kind || ""
      },
      "*"
    );
    return;
  }

  if (msg?.type === "JOBMATE_APPLY_STARTED") {
    window.postMessage(
      {
        source: "jobmate-extension",
        type: "JOBMATE_APPLY_STARTED",
        tabId: typeof msg.tabId === "number" ? msg.tabId : null,
        applyUrl: msg.applyUrl || ""
      },
      "*"
    );
    return;
  }

  if (msg?.type === "JOBMATE_FETCH_APP_CONFIG") {
    const requestId = crypto.randomUUID();

    function onPageReply(ev) {
      if (ev.source !== window) {
        return;
      }
      const d = ev.data;
      if (!d || d.source !== "jobmate-web" || d.type !== "JOBMATE_WEB_CONFIG" || d.requestId !== requestId) {
        return;
      }
      window.removeEventListener("message", onPageReply);
      sendResponse({
        ok: Boolean(d.ok),
        config: d.config ?? null,
        error: typeof d.error === "string" ? d.error : null
      });
    }

    window.addEventListener("message", onPageReply);
    window.postMessage(
      {
        source: "jobmate-extension",
        type: "JOBMATE_WEB_CONFIG_REQUEST",
        requestId
      },
      "*"
    );

    return true;
  }
});

function notifyJobMateAppPageReady() {
  if (!isJobMateAppUrl(location.href)) {
    return;
  }
  chrome.runtime.sendMessage({ type: "JOBMATE_APP_PAGE_READY" }).catch(() => {});
}

notifyJobMateAppPageReady();

window.addEventListener("message", (ev) => {
  if (ev.source !== window) {
    return;
  }

  const d = ev.data;

  if (!d || d.source !== "jobmate-web") {
    return;
  }

  if (d.type === "JOBMATE_WEB_APP_READY") {
    notifyJobMateAppPageReady();
    return;
  }

  if (d.type === "JOBMATE_EXTENSION_VERSION") {
    const manifest = chrome.runtime.getManifest();
    window.postMessage(
      {
        source: "jobmate-extension",
        requestId: d.requestId,
        ok: true,
        version: manifest.version || ""
      },
      "*"
    );
    return;
  }

  const ALLOWED_TYPES = [
    "GOOGLE_SEARCH_BATCH",
    "JOBTEASER_SEARCH_BATCH",
    "WORKATASTARTUP_SEARCH_BATCH",
    "FETCH_PAGE_HTML",
    "JOBMATE_OPEN_BACKGROUND_TAB",
    "JOBMATE_OPEN_APPLY_TAB",
    "JOBMATE_EMAIL_SYNC",
    "JOBMATE_INTERRUPT_APPLY_TAB"
  ];

  if (!ALLOWED_TYPES.includes(d.type)) {
    return;
  }

  let bgMsg;

  if (d.type === "GOOGLE_SEARCH_BATCH") {
    bgMsg = { type: "GOOGLE_SEARCH_BATCH", requestId: d.requestId, queries: d.queries, limitPerQuery: d.limitPerQuery };
  } else if (d.type === "JOBTEASER_SEARCH_BATCH") {
    bgMsg = { type: "JOBTEASER_SEARCH_BATCH", requestId: d.requestId, specs: d.specs, limitPerSpec: d.limitPerSpec };
  } else if (d.type === "WORKATASTARTUP_SEARCH_BATCH") {
    bgMsg = { type: "WORKATASTARTUP_SEARCH_BATCH", requestId: d.requestId, specs: d.specs, limitPerSpec: d.limitPerSpec };
  } else if (d.type === "FETCH_PAGE_HTML") {
    bgMsg = { type: "FETCH_PAGE_HTML", requestId: d.requestId, url: d.url };
  } else if (d.type === "JOBMATE_OPEN_BACKGROUND_TAB") {
    bgMsg = { type: "JOBMATE_OPEN_BACKGROUND_TAB", requestId: d.requestId, url: d.url };
  } else if (d.type === "JOBMATE_OPEN_APPLY_TAB") {
    bgMsg = { type: "JOBMATE_OPEN_APPLY_TAB", requestId: d.requestId, url: d.url, payloadUrl: d.payloadUrl, sessionId: d.sessionId, jobData: d.jobData };
  } else if (d.type === "JOBMATE_EMAIL_SYNC") {
    bgMsg = { type: "JOBMATE_EMAIL_SYNC", requestId: d.requestId, url: d.url };
  } else if (d.type === "JOBMATE_INTERRUPT_APPLY_TAB") {
    bgMsg = { type: "JOBMATE_INTERRUPT_APPLY_TAB", requestId: d.requestId, tabId: d.tabId };
  }

  chrome.runtime.sendMessage(bgMsg, (resp) => {
    const last = chrome.runtime.lastError;

    window.postMessage(
      {
        source: "jobmate-extension",
        requestId: d.requestId,
        ok: Boolean(resp?.ok) && !last,
        error: last?.message || resp?.error || null,
        byQuery: resp?.byQuery ?? null,
        bySpecId: resp?.bySpecId ?? null,
        finalUrl: typeof resp?.finalUrl === "string" ? resp.finalUrl : null,
        html: typeof resp?.html === "string" ? resp.html : null,
        tabId: typeof resp?.tabId === "number" ? resp.tabId : null,
        text: typeof resp?.text === "string" ? resp.text : null
      },
      "*"
    );
  });
});
