import type { SearchCandidate } from "../../../lib/types";
import type { JobTeaserSearchSpec } from "../../../lib/services/jobteaser";

type ExtensionRequest = {
  source: string;
  type: string;
  requestId: string;
};

type JobTeaserReply = ExtensionRequest & {
  ok?: boolean;
  error?: string | null;
  bySpecId?: Record<string, SearchCandidate[]> | null;
};

export async function fetchJobTeaserCandidatesViaExtensionBatch(
  specs: JobTeaserSearchSpec[],
  limitPerSpec: number
): Promise<Map<string, SearchCandidate[]>> {
  if (typeof window === "undefined") {
    throw new Error("JobTeaser search requires a browser window.");
  }

  const uniqueSpecs = Array.from(
    new Map(
      specs
        .map((spec) => [spec.id, spec] as const)
        .filter((entry) => entry[1].url.trim())
    ).values()
  );

  if (!uniqueSpecs.length) {
    return new Map();
  }

  const cap = Math.max(1, Math.min(100, limitPerSpec));

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond to the JobTeaser search request."));
    }, 240_000);

    function onReply(ev: MessageEvent) {
      const data = ev.data as JobTeaserReply;

      if (!data || data.source !== "jobmate-extension" || data.requestId !== requestId) {
        return;
      }

      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);

      if (!data.ok) {
        reject(new Error(data.error || "Extension JobTeaser search failed."));
        return;
      }

      const lookup = new Map<string, SearchCandidate[]>();

      for (const spec of uniqueSpecs) {
        const rows = data.bySpecId?.[spec.id];
        lookup.set(spec.id, Array.isArray(rows) ? rows : []);
      }

      resolve(lookup);
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: "JOBTEASER_SEARCH_BATCH",
        requestId,
        specs: uniqueSpecs,
        limitPerSpec: cap
      },
      "*"
    );
  });
}
