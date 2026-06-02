import type { OrganicSearchResult } from "../../../lib/services/organic-search";

type BatchPayload = {
  source: string;
  type: string;
  requestId: string;
  queries?: unknown[];
  limitPerQuery?: number;
};

export async function fetchGoogleOrganicViaExtensionBatch(
  queries: string[],
  limitPerQuery: number
): Promise<Map<string, OrganicSearchResult[]>> {
  if (typeof window === "undefined") {
    throw new Error("Extension search requires a browser window.");
  }

  const trimmedList = queries.map((q) => q.trim()).filter(Boolean);
  const uniqQueries = [...new Set(trimmedList)];

  if (!uniqQueries.length) {
    return new Map();
  }

  const cap = Math.max(1, Math.min(100, limitPerQuery));

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond (reload the extension on chrome://extensions)."));
    }, 240000);

    function onReply(ev: MessageEvent) {
      const d = ev.data as BatchPayload & {
        ok?: boolean;
        error?: string | null;
        byQuery?: Record<string, OrganicSearchResult[]> | null;
      };

      if (!d || d.source !== "jobmate-extension" || d.requestId !== requestId) {
        return;
      }

      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);

      if (!d.ok) {
        reject(new Error(d.error || "Extension Google search failed."));
        return;
      }

      const lookup = new Map<string, OrganicSearchResult[]>();

      for (const q of uniqQueries) {
        const rows = d.byQuery?.[q];
        lookup.set(q, Array.isArray(rows) ? rows : []);
      }

      resolve(lookup);
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: "GOOGLE_SEARCH_BATCH",
        requestId,
        queries: uniqQueries,
        limitPerQuery: cap
      },
      "*"
    );
  });
}
