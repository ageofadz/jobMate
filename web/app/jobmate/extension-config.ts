import { formatProfileBlock } from "./format-profile-block";
import {
  SETTING_APPLY_EMAIL,
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL
} from "./kv-keys";
import type { JobmateSqlite } from "./sqlite-client";

export type ExtensionStorageConfig = {
  geminiApiKey: string;
  geminiModel: string;
  candidateName: string;
  candidateEmail: string;
  contextBlock: string;
  writingSample: string;
  coverLetterTemplate: string;
  resumePdfBase64: string;
  resumePdfFilename: string;
  resumePdfMimeType: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function blobToUint8Array(blob: unknown): Uint8Array | null {
  if (blob instanceof Uint8Array) {
    return blob;
  }
  if (blob instanceof ArrayBuffer) {
    return new Uint8Array(blob);
  }
  if (Array.isArray(blob)) {
    return Uint8Array.from(blob);
  }
  return null;
}

export async function loadExtensionConfigFromSqlite(
  sqlite: JobmateSqlite,
  userId: string
): Promise<ExtensionStorageConfig> {
  const gemRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
    SETTING_GEMINI_API_KEY
  ]);
  const modRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
    SETTING_GEMINI_MODEL
  ]);
  const applyEmailRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
    SETTING_APPLY_EMAIL
  ]);

  const profileRows = await sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId]);
  const profile = profileRows[0] ?? {};

  const geminiApiKey = gemRows[0]?.value?.trim() ?? "";
  const geminiModel = modRows[0]?.value?.trim() || "gemini-3.1-flash-lite";
  const applyEmail = applyEmailRows[0]?.value?.trim() ?? "";
  const profileEmail = String(profile.email ?? "").trim();
  const candidateName = String(profile.full_name ?? "").trim();
  const candidateEmail = applyEmail || profileEmail;
  const contextBlock = formatProfileBlock(profile);
  const writingSample = String(profile.essay ?? "").trim();
  const coverLetterTemplate = String(profile.cover_letter_template ?? "").trim();

  let resumePdfBase64 = "";
  let resumePdfFilename = "";
  let resumePdfMimeType = "";

  const resumeAssetId = String(profile.resume_asset_id ?? "").trim();
  if (resumeAssetId) {
    const assetRows = await sqlite.all<{
      filename: string;
      mime_type: string;
      file_blob: unknown;
    }>(`SELECT filename, mime_type, file_blob FROM assets WHERE id = ? AND user_id = ?`, [
      resumeAssetId,
      userId
    ]);
    const asset = assetRows[0];
    const bytes = asset ? blobToUint8Array(asset.file_blob) : null;
    if (asset && bytes && bytes.length > 0) {
      resumePdfBase64 = bytesToBase64(bytes);
      resumePdfFilename = String(asset.filename ?? "").trim() || "resume.pdf";
      resumePdfMimeType = String(asset.mime_type ?? "").trim() || "application/pdf";
    }
  }

  return {
    geminiApiKey,
    geminiModel,
    candidateName,
    candidateEmail,
    contextBlock,
    writingSample,
    coverLetterTemplate,
    resumePdfBase64,
    resumePdfFilename,
    resumePdfMimeType
  };
}
