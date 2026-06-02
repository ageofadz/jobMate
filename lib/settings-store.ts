import { getSqlite } from "@/lib/db";

export const SETTING_GEMINI_API_KEY = "gemini_api_key";
export const SETTING_GEMINI_MODEL = "gemini_model";
export const SETTING_NOTIFICATION_WEBHOOK_URL = "notification_webhook_url";
export const SETTING_INITIAL_SETUP_COMPLETE = "initial_setup_complete";
export const SETTING_LANGUAGE = "language";
export const SETTING_CHROME_EXTENSION_OUTPUT_DIR = "chrome_extension_output_dir";
export const SETTING_APPLY_EMAIL = "apply_email";

export function getSetting(key: string): string | null {
  const db = getSqlite();
  const row = db.prepare(`SELECT value FROM kv_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  const db = getSqlite();
  db.prepare(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`).run(key, value);
}

export function getGeminiApiKey() {
  return getSetting(SETTING_GEMINI_API_KEY) ?? undefined;
}

export function getGeminiModel() {
  return getSetting(SETTING_GEMINI_MODEL) || "gemini-3.1-flash-lite";
}

export function getNotificationWebhookUrl() {
  const v = getSetting(SETTING_NOTIFICATION_WEBHOOK_URL);
  return v?.trim() ? v : undefined;
}

export function getLanguageSetting() {
  return getSetting(SETTING_LANGUAGE) ?? "en";
}

export function getChromeExtensionOutputDir() {
  const v = getSetting(SETTING_CHROME_EXTENSION_OUTPUT_DIR);
  return v?.trim() ? v.trim() : undefined;
}

export function getApplyEmail() {
  const v = getSetting(SETTING_APPLY_EMAIL);
  return v?.trim() ? v.trim() : undefined;
}

export function isInitialSetupComplete() {
  return getSetting(SETTING_INITIAL_SETUP_COMPLETE) === "1";
}
