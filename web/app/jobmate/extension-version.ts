import extensionManifest from "@/chrome-extension/manifest.json";

export const JOBMATE_EXTENSION_VERSION = extensionManifest.version;

type ExtensionVersionReply = {
  source?: string;
  requestId?: string;
  ok?: boolean;
  version?: string;
  error?: string | null;
};

export function pingExtensionVersion(): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("Extension version check requires a browser window.");
  }

  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      reject(new Error("JobMate extension did not respond."));
    }, 4000);

    function onReply(ev: MessageEvent) {
      const data = ev.data as ExtensionVersionReply;
      if (!data || data.source !== "jobmate-extension" || data.requestId !== requestId) {
        return;
      }
      window.removeEventListener("message", onReply);
      window.clearTimeout(timer);
      if (!data.ok || !data.version?.trim()) {
        reject(new Error(data.error || "JobMate extension did not respond."));
        return;
      }
      resolve(data.version.trim());
    }

    window.addEventListener("message", onReply);
    window.postMessage(
      {
        source: "jobmate-web",
        type: "JOBMATE_EXTENSION_VERSION",
        requestId
      },
      "*"
    );
  });
}
