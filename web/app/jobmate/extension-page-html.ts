type ExtensionRequest = {
  source: string;
  type: string;
  requestId: string;
};

type FetchPageHtmlReply = ExtensionRequest & {
  ok?: boolean;
  error?: string | null;
  finalUrl?: string;
  html?: string;
};

export async function fetchPageHtmlViaExtension(url: string): Promise<{ html: string; finalUrl: string; ok: boolean }> {
  if (typeof window === "undefined") {
    throw new Error("Extension HTML fetch requires a browser window.");
  }

  const trimmed = url.trim();

  if (!trimmed) {
    throw new Error("Extension HTML fetch requires a URL.");
  }

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond to the HTML fetch request."));
    }, 240_000);

    function onReply(ev: MessageEvent) {
      const data = ev.data as FetchPageHtmlReply;

      if (!data || data.source !== "jobmate-extension" || data.requestId !== requestId) {
        return;
      }

      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);

      if (!data.ok) {
        reject(new Error(data.error || "Extension HTML fetch failed."));
        return;
      }

      resolve({
        ok: true,
        finalUrl: String(data.finalUrl ?? trimmed),
        html: String(data.html ?? "")
      });
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: "FETCH_PAGE_HTML",
        requestId,
        url: trimmed
      },
      "*"
    );
  });
}
