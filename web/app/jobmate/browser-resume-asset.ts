import type { JobmateSqlite } from "./sqlite-client";

function baseFileName(pathLike: string) {
  const normalized = pathLike.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

function safeFileName(filename: string) {
  return baseFileName(filename)
    .replace(/[^\w .()-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveStoragePath(sqlite: JobmateSqlite, userId: string, preferredFilename: string, assetId: string) {
  const safe = safeFileName(preferredFilename);
  let relative = safe || assetId;

  const takenRows = await sqlite.all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM assets WHERE user_id = ? AND storage_path = ?`,
    [userId, relative]
  );

  if (Number(takenRows[0]?.c ?? 0) === 0) {
    return relative;
  }

  const dot = relative.lastIndexOf(".");
  const stem = dot > 0 ? relative.slice(0, dot) : relative;
  const ext = dot > 0 ? relative.slice(dot) : "";
  return `${stem}-${assetId.slice(0, 8)}${ext}`;
}

export async function insertResumePdfAsset(sqlite: JobmateSqlite, userId: string, file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const assetId = crypto.randomUUID();
  const now = new Date().toISOString();
  const filename = file.name.trim() || "resume.pdf";
  const mimeType = file.type.trim() || "application/pdf";
  const storagePath = await resolveStoragePath(sqlite, userId, filename, assetId);

  await sqlite.run(
    `INSERT INTO assets (id, user_id, kind, filename, mime_type, byte_length, storage_path, extracted_text, file_blob, created_at)
     VALUES (?, ?, 'resume_pdf', ?, ?, ?, ?, ?, ?, ?)`,
    [assetId, userId, filename, mimeType, buf.byteLength, storagePath, null, bytes, now]
  );

  return assetId;
}

export async function setUserResumeAsset(sqlite: JobmateSqlite, userId: string, resumeAssetId: string | null) {
  const now = new Date().toISOString();
  await sqlite.run(`UPDATE users SET resume_asset_id = ?, updated_at = ? WHERE id = ?`, [resumeAssetId, now, userId]);
}
