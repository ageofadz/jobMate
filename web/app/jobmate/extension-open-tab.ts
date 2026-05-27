type ExtensionReply = {
  source: string;
  requestId: string;
  ok?: boolean;
  error?: string | null;
  tabId?: number | null;
};

export type ApplySessionJobData = {
  jobId: string;
  title: string;
  company: string;
  companyHomepage: string;
  listingText: string;
  linkedinLinks: string[];
  hiringContacts: string[];
};

export function openBackgroundTabViaExtension(url: string, payloadUrl?: string): Promise<{ tabId: number | null }> {
  if (typeof window === "undefined") {
    throw new Error("Extension tab open requires a browser window.");
  }

  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Extension tab open requires a URL.");
  }

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond to the tab open request."));
    }, 60_000);

    function onReply(ev: MessageEvent) {
      const data = ev.data as ExtensionReply;
      if (!data || data.source !== "jobmate-extension" || data.requestId !== requestId) {
        return;
      }
      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);
      if (!data.ok) {
        reject(new Error(data.error || "Extension tab open failed."));
        return;
      }
      resolve({ tabId: typeof data.tabId === "number" ? data.tabId : null });
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: payloadUrl ? "JOBMATE_OPEN_APPLY_TAB" : "JOBMATE_OPEN_BACKGROUND_TAB",
        requestId,
        url: trimmed,
        payloadUrl: payloadUrl ?? ""
      },
      "*"
    );
  });
}

export function openApplyTabViaExtension(applyUrl: string, sessionId: string, jobData: ApplySessionJobData): Promise<{ tabId: number | null }> {
  if (typeof window === "undefined") {
    throw new Error("Extension tab open requires a browser window.");
  }

  const trimmed = applyUrl.trim();
  if (!trimmed) {
    throw new Error("Extension tab open requires a URL.");
  }

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond to the tab open request."));
    }, 60_000);

    function onReply(ev: MessageEvent) {
      const data = ev.data as ExtensionReply;
      if (!data || data.source !== "jobmate-extension" || data.requestId !== requestId) {
        return;
      }
      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);
      if (!data.ok) {
        reject(new Error(data.error || "Extension tab open failed."));
        return;
      }
      resolve({ tabId: typeof data.tabId === "number" ? data.tabId : null });
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: "JOBMATE_OPEN_APPLY_TAB",
        requestId,
        url: trimmed,
        sessionId,
        jobData
      },
      "*"
    );
  });
}
