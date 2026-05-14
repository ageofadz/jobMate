import type { ChromeApplyPayload } from "../../lib/chrome-extension/payload-server";

type StoredEntry = {
  payload: ChromeApplyPayload;
  geminiApiKey: string;
  geminiModel: string;
};

const entries = new Map<string, StoredEntry>();

export const chromeApplyCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type"
};

export function putChromeApplySession(id: string, entry: StoredEntry) {
  entries.set(id, entry);
}

export function getChromeApplySession(id: string) {
  return entries.get(id);
}

export function publicChromeApplyPayload(payload: ChromeApplyPayload) {
  const {
    contextBlock: _contextBlock,
    listingText: _listingText,
    resumeText: _resumeText,
    writingSample: _writingSample,
    coverLetterTemplate: _coverLetterTemplate,
    ...safe
  } = payload;
  return safe;
}
