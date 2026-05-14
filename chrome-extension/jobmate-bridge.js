window.addEventListener("message", (ev) => {
  if (ev.source !== window) {
    return;
  }

  const d = ev.data;

  if (!d || d.source !== "jobmate-web") {
    return;
  }

  if (d.type !== "GOOGLE_SEARCH_BATCH") {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "GOOGLE_SEARCH_BATCH",
      requestId: d.requestId,
      queries: d.queries,
      limitPerQuery: d.limitPerQuery
    },
    (resp) => {
      const last = chrome.runtime.lastError;

      window.postMessage(
        {
          source: "jobmate-extension",
          requestId: d.requestId,
          ok: Boolean(resp?.ok) && !last,
          error: last?.message || resp?.error || null,
          byQuery: resp?.byQuery ?? null
        },
        "*"
      );
    }
  );
});
