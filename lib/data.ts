import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { normalizeApplyUrl } from "@/lib/apply-url";
import { getSqlite } from "@/lib/db";
import { getFilesDir } from "@/lib/env";
import { writeUploadedFile, readUploadedFileRelative } from "@/lib/files";
import { enrichPreferenceInput } from "@/lib/services/keywords";
import type { PreferenceInput } from "@/lib/validators";

export async function getPreferencesForUser(userId: string) {
  const db = getSqlite();
  const rows = db
    .prepare(`SELECT * FROM preferences WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as PreferenceRow[];

  return rows.map(mapPreferenceRow);
}

export async function getDigestsForUser(userId: string) {
  const db = getSqlite();
  const rows = db.prepare(`SELECT * FROM digests WHERE user_id = ? ORDER BY date DESC LIMIT 14`).all(userId) as DigestRow[];

  return rows.map(mapDigestRow);
}

export async function getDigestJobs(userId: string, digestDate: string) {
  const db = getSqlite();
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE user_id = ? AND digest_date = ? ORDER BY discovered_at DESC`)
    .all(userId, digestDate) as JobRow[];

  return rows.map(mapJobRow);
}

export async function getJobById(userId: string, jobId: string) {
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ? AND user_id = ?`).get(jobId, userId) as JobRow | undefined;

  return row ? mapJobRow(row) : null;
}

export async function getLatestResumeAsset(userId: string) {
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT * FROM assets WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId, "resume_pdf") as AssetRow | undefined;

  return row ? mapAssetRow(row) : null;
}

export async function resolveAssetAbsolutePath(assetId: string, userId: string) {
  const db = getSqlite();
  const row = db.prepare(`SELECT storage_path FROM assets WHERE id = ? AND user_id = ?`).get(assetId, userId) as
    | { storage_path: string }
    | undefined;

  if (!row) {
    return null;
  }

  return path.join(getFilesDir(), row.storage_path);
}

export async function getAssetUploadInfo(assetId: string, userId: string) {
  const db = getSqlite();
  const row = db
    .prepare(`SELECT filename, mime_type, storage_path FROM assets WHERE id = ? AND user_id = ?`)
    .get(assetId, userId) as { filename: string; mime_type: string; storage_path: string } | undefined;

  if (!row) {
    return null;
  }

  return {
    filename: row.filename,
    mimeType: row.mime_type,
    absolutePath: path.join(getFilesDir(), row.storage_path)
  };
}

type PreferenceRow = {
  id: string;
  user_id: string;
  title: string;
  enabled: number;
  locations: string;
  board_domains: string;
  keyword_seed: string;
  generated_keywords: string;
  search_queries: string;
  search_after_days: number;
  context_block: string;
  timezone: string;
  schedule_hour_local: number;
  resume_asset_id: string | null;
  created_at: string;
  updated_at: string;
};

type DigestRow = {
  id: string;
  user_id: string;
  date: string;
  job_ids: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  user_id: string;
  preference_id: string;
  digest_date: string;
  source_url: string;
  source_host: string;
  source_title: string;
  company: string;
  location: string;
  compensation_range: string | null;
  company_homepage: string | null;
  linkedin_links: string | null;
  hiring_contacts: string | null;
  summary: string;
  listing_text: string;
  apply_url: string;
  fields: string;
  resume_asset_id: string | null;
  cover_letter_asset_id: string | null;
  status: string;
  discovered_at: string;
  applied_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AssetRow = {
  id: string;
  user_id: string;
  kind: string;
  filename: string;
  mime_type: string;
  byte_length: number;
  storage_path: string;
  extracted_text: string | null;
  created_at: string;
};

function mapPreferenceRow(row: PreferenceRow): Record<string, unknown> {
  return {
    _id: row.id,
    userId: row.user_id,
    title: row.title,
    enabled: row.enabled !== 0,
    locations: JSON.parse(row.locations),
    boardDomains: JSON.parse(row.board_domains),
    keywordSeed: JSON.parse(row.keyword_seed),
    generatedKeywords: JSON.parse(row.generated_keywords),
    searchQueries: JSON.parse(row.search_queries),
    searchAfterDays: row.search_after_days ?? 14,
    contextBlock: row.context_block,
    timezone: row.timezone,
    scheduleHourLocal: row.schedule_hour_local,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDigestRow(row: DigestRow): Record<string, unknown> {
  return {
    _id: row.id,
    userId: row.user_id,
    date: row.date,
    jobIds: JSON.parse(row.job_ids),
    sentAt: row.sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapJobRow(row: JobRow): Record<string, unknown> {
  return {
    _id: row.id,
    userId: row.user_id,
    preferenceId: row.preference_id,
    digestDate: row.digest_date,
    sourceUrl: row.source_url,
    sourceHost: row.source_host,
    sourceTitle: row.source_title,
    company: row.company,
    location: row.location,
    compensationRange: row.compensation_range ?? undefined,
    companyHomepage: row.company_homepage ?? undefined,
    linkedinLinks: parseJsonArray(row.linkedin_links),
    hiringContacts: parseJsonArray(row.hiring_contacts),
    summary: row.summary,
    listingText: row.listing_text,
    applyUrl: row.apply_url,
    fields: JSON.parse(row.fields),
    resumeAssetId: row.resume_asset_id ?? undefined,
    coverLetterAssetId: row.cover_letter_asset_id ?? undefined,
    status: row.status,
    discoveredAt: row.discovered_at,
    appliedAt: row.applied_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function mapAssetRow(row: AssetRow): Record<string, unknown> {
  return {
    _id: row.id,
    userId: row.user_id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    storagePath: row.storage_path,
    extractedText: row.extracted_text ?? undefined,
    createdAt: row.created_at
  };
}

export async function loadResumeText(userId: string, assetId: string | null | undefined) {
  if (!assetId) {
    return "";
  }

  const db = getSqlite();
  const row = db
    .prepare(`SELECT extracted_text FROM assets WHERE id = ? AND user_id = ?`)
    .get(assetId, userId) as { extracted_text: string | null } | undefined;

  return row?.extracted_text ?? "";
}

export function loadResumePdfPayload(userId: string, assetId: string | null | undefined) {
  if (!assetId) {
    return null;
  }

  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT filename, mime_type, storage_path, file_blob FROM assets WHERE id = ? AND user_id = ? AND kind = ?`
    )
    .get(assetId, userId, "resume_pdf") as
    | { filename: string; mime_type: string; storage_path: string; file_blob: Buffer | null | Uint8Array }
    | undefined;

  if (!row) {
    return null;
  }

  let buffer: Buffer | null = null;

  if (row.file_blob) {
    if (Buffer.isBuffer(row.file_blob) && row.file_blob.byteLength > 0) {
      buffer = row.file_blob;
    } else if (row.file_blob instanceof Uint8Array && row.file_blob.byteLength > 0) {
      buffer = Buffer.from(row.file_blob);
    }
  }

  if (!buffer) {
    try {
      buffer = readUploadedFileRelative(row.storage_path);
    } catch {
      buffer = null;
    }
  }

  if (!buffer || buffer.byteLength === 0) {
    return null;
  }

  return {
    buffer,
    filename: row.filename,
    mimeType: row.mime_type?.trim() ? row.mime_type : "application/pdf"
  };
}

export function listJobsNotApplied(userId: string) {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE user_id = ? AND status IN ('new', 'reviewed') ORDER BY discovered_at DESC`
    )
    .all(userId) as JobRow[];

  return rows.map(mapJobRow);
}

export function listJobsForResults(userId: string) {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE user_id = ? AND status IN ('new', 'reviewed') ORDER BY discovered_at DESC`
    )
    .all(userId) as JobRow[];

  return rows.map(mapJobRow);
}

export function listJobsByStatus(userId: string, statuses: string[]) {
  const db = getSqlite();
  const allow = new Set(["new", "reviewed", "applied", "archived", "dismissed"]);
  const filtered = statuses.filter((status) => allow.has(status));

  if (!filtered.length) {
    return [];
  }

  const placeholders = filtered.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE user_id = ? AND status IN (${placeholders}) ORDER BY COALESCE(applied_at, archived_at, discovered_at) DESC`
    )
    .all(userId, ...filtered) as JobRow[];

  return rows.map(mapJobRow);
}

export type MarkJobAppliedOptions = {
  applicationUrl?: string;
};

export function markJobApplied(userId: string, jobId: string, options?: MarkJobAppliedOptions) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const row = db
    .prepare(
      `SELECT apply_url, hiring_contacts, linkedin_links FROM jobs WHERE id = ? AND user_id = ?`
    )
    .get(jobId, userId) as { apply_url: string; hiring_contacts: string | null; linkedin_links: string | null } | undefined;

  if (!row) {
    return false;
  }

  const trimmed = options?.applicationUrl?.trim();
  const applicationUrl = trimmed ? trimmed : normalizeApplyUrl(row.apply_url);
  const contactsSnapshot = row.hiring_contacts ?? "[]";
  const linkedinSnapshot = row.linkedin_links ?? "[]";

  const result = db
    .prepare(
      `UPDATE jobs SET status = ?, applied_at = ?, applied_application_url = ?, applied_at_hiring_contacts = ?, applied_at_linkedin_links = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    )
    .run("applied", now, applicationUrl, contactsSnapshot, linkedinSnapshot, now, jobId, userId);

  return result.changes > 0;
}

export function archiveJob(userId: string, jobId: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const result = db
    .prepare(`UPDATE jobs SET status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run("archived", now, now, jobId, userId);

  return result.changes > 0;
}

export function unarchiveJob(userId: string, jobId: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const result = db
    .prepare(`UPDATE jobs SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('archived', 'dismissed')`)
    .run("new", now, jobId, userId);

  return result.changes > 0;
}

export function unapplyJob(userId: string, jobId: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE jobs SET status = ?, applied_at = NULL, applied_application_url = NULL, applied_at_hiring_contacts = '[]', applied_at_linkedin_links = '[]', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'applied'`
    )
    .run("new", now, jobId, userId);

  return result.changes > 0;
}

export function deleteJob(userId: string, jobId: string) {
  const db = getSqlite();
  const result = db.prepare(`DELETE FROM jobs WHERE id = ? AND user_id = ?`).run(jobId, userId);
  return result.changes > 0;
}

export function clearJobHistoryForUser(userId: string) {
  const db = getSqlite();
  const result = db
    .prepare(`DELETE FROM jobs WHERE user_id = ? AND status IN ('applied', 'archived', 'dismissed')`)
    .run(userId);

  return result.changes;
}

export function listDailyMetrics(userId: string, days = 14) {
  const db = getSqlite();
  const rows = db
    .prepare(
      `WITH dates AS (
        SELECT substr(discovered_at, 1, 10) AS day FROM jobs WHERE user_id = ?
        UNION
        SELECT substr(applied_at, 1, 10) AS day FROM jobs WHERE user_id = ? AND applied_at IS NOT NULL
      )
      SELECT
        day,
        (SELECT COUNT(*) FROM jobs j WHERE j.user_id = ? AND substr(j.discovered_at, 1, 10) = dates.day) AS retrieved,
        (SELECT COUNT(*) FROM jobs j WHERE j.user_id = ? AND j.applied_at IS NOT NULL AND substr(j.applied_at, 1, 10) = dates.day) AS applied
      FROM dates
      ORDER BY day DESC
      LIMIT ?`
    )
    .all(userId, userId, userId, userId, days) as Array<{ day: string; retrieved: number; applied: number }>;

  return rows;
}

export function countPreferencesForUser(userId: string) {
  const db = getSqlite();
  const row = db.prepare(`SELECT COUNT(*) as c FROM preferences WHERE user_id = ?`).get(userId) as { c: number };
  return row.c;
}

export function listPreferencesMaps(userId: string) {
  const db = getSqlite();
  const rows = db
    .prepare(`SELECT * FROM preferences WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as PreferenceRow[];

  return rows.map(mapPreferenceRow);
}

export function getPreferenceMap(userId: string, preferenceId: string) {
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM preferences WHERE id = ? AND user_id = ?`).get(preferenceId, userId) as
    | PreferenceRow
    | undefined;

  return row ? mapPreferenceRow(row) : null;
}

export function insertPreference(userId: string, input: PreferenceInput) {
  const enriched = enrichPreferenceInput(input);
  const db = getSqlite();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO preferences (
      id, user_id, title, enabled, locations, board_domains, keyword_seed, generated_keywords,
      search_queries, search_after_days, context_block, timezone, schedule_hour_local, resume_asset_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    enriched.title,
    1,
    JSON.stringify(enriched.locations),
    JSON.stringify(enriched.boardDomains),
    JSON.stringify(enriched.keywordSeed),
    JSON.stringify(enriched.generatedKeywords),
    JSON.stringify(enriched.searchQueries),
    enriched.searchAfterDays,
    enriched.contextBlock,
    enriched.timezone,
    enriched.scheduleHourLocal,
    null,
    now,
    now
  );

  return id;
}

export function updatePreference(userId: string, preferenceId: string, input: PreferenceInput) {
  const enriched = enrichPreferenceInput(input);
  const db = getSqlite();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE preferences SET
        title = ?,
        locations = ?,
        board_domains = ?,
        keyword_seed = ?,
        generated_keywords = ?,
        search_queries = ?,
        search_after_days = ?,
        context_block = ?,
        timezone = ?,
        schedule_hour_local = ?,
        resume_asset_id = ?,
        updated_at = ?
      WHERE id = ? AND user_id = ?`
    )
    .run(
      enriched.title,
      JSON.stringify(enriched.locations),
      JSON.stringify(enriched.boardDomains),
      JSON.stringify(enriched.keywordSeed),
      JSON.stringify(enriched.generatedKeywords),
      JSON.stringify(enriched.searchQueries),
      enriched.searchAfterDays,
      enriched.contextBlock,
      enriched.timezone,
      enriched.scheduleHourLocal,
      null,
      now,
      preferenceId,
      userId
    );

  return result.changes > 0;
}

export function setPreferenceEnabled(userId: string, preferenceId: string, enabled: boolean) {
  const db = getSqlite();
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE preferences SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(enabled ? 1 : 0, now, preferenceId, userId);

  return result.changes > 0;
}

export function deletePreference(userId: string, preferenceId: string) {
  const db = getSqlite();
  const result = db.prepare(`DELETE FROM preferences WHERE id = ? AND user_id = ?`).run(preferenceId, userId);
  return result.changes > 0;
}

export function createResumeAssetFromPath(userId: string, absolutePath: string) {
  const resolved = path.resolve(absolutePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const buffer = fs.readFileSync(resolved);
  const { relativePath } = writeUploadedFile(buffer, path.basename(resolved));
  const assetId = randomUUID();
  const now = new Date().toISOString();
  const db = getSqlite();

  db.prepare(
    `INSERT INTO assets (id, user_id, kind, filename, mime_type, byte_length, storage_path, extracted_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assetId,
    userId,
    "resume_pdf",
    path.basename(resolved),
    "application/pdf",
    buffer.byteLength,
    relativePath,
    null,
    now
  );

  return assetId;
}

export function setUserResumeAsset(userId: string, resumeAssetId: string | null) {
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(`UPDATE users SET resume_asset_id = ?, updated_at = ? WHERE id = ?`).run(resumeAssetId, now, userId);
}

export type UserProfile = {
  id: string;
  email: string;
  fullName: string | null;
  location: string | null;
  currentLocation: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  preferredCompRange: string | null;
  coverLetterTemplate: string | null;
  website: string | null;
  workHistory: string | null;
  skills: string | null;
  essay: string | null;
  resumeAssetId: string | null;
  createdAt: string;
  updatedAt: string;
};

type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  location: string | null;
  current_location: string | null;
  phone: string | null;
  linkedin_url: string | null;
  preferred_comp_range: string | null;
  cover_letter_template: string | null;
  website: string | null;
  work_history: string | null;
  skills: string | null;
  essay: string | null;
  resume_asset_id: string | null;
  created_at: string;
  updated_at: string;
};

function mapUserRow(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    location: row.location,
    currentLocation: row.current_location,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    preferredCompRange: row.preferred_comp_range,
    coverLetterTemplate: row.cover_letter_template,
    website: row.website,
    workHistory: row.work_history,
    skills: row.skills,
    essay: row.essay,
    resumeAssetId: row.resume_asset_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getUserProfile(userId: string): UserProfile | null {
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = [];

  if (profile.fullName?.trim()) {
    lines.push(`Name: ${profile.fullName.trim()}`);
  }

  if (profile.email.trim()) {
    lines.push(`Email: ${profile.email}`);
  }

  if (profile.location?.trim()) {
    lines.push(`Location: ${profile.location.trim()}`);
  }

  if (profile.currentLocation?.trim()) {
    lines.push(`Current location: ${profile.currentLocation.trim()}`);
  }

  if (profile.phone?.trim()) {
    lines.push(`Phone: ${profile.phone.trim()}`);
  }

  if (profile.linkedinUrl?.trim()) {
    lines.push(`LinkedIn: ${profile.linkedinUrl.trim()}`);
  }

  if (profile.preferredCompRange?.trim()) {
    lines.push(`Preferred compensation range: ${profile.preferredCompRange.trim()}`);
  }

  if (profile.website?.trim()) {
    lines.push(`Website: ${profile.website.trim()}`);
  }

  if (profile.workHistory?.trim()) {
    lines.push(`Work history:\n${profile.workHistory.trim()}`);
  }

  if (profile.skills?.trim()) {
    lines.push(`Skills:\n${profile.skills.trim()}`);
  }

  if (profile.essay?.trim()) {
    lines.push(`Writing sample:\n${profile.essay.trim()}`);
  }

  return lines.join("\n\n");
}

export function insertUserProfile(input: {
  id: string;
  email: string;
  fullName: string;
  location: string;
  currentLocation: string;
  phone: string;
  linkedinUrl: string;
  preferredCompRange: string;
  coverLetterTemplate?: string;
  website: string;
  workHistory: string;
  skills: string;
  essay?: string;
}) {
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, full_name, location, current_location, phone, linkedin_url, preferred_comp_range, cover_letter_template, website, work_history, skills, essay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.email.toLowerCase(),
    input.fullName,
    input.location,
    input.currentLocation,
    input.phone,
    input.linkedinUrl,
    input.preferredCompRange,
    input.coverLetterTemplate ?? "",
    input.website,
    input.workHistory,
    input.skills,
    input.essay ?? "",
    now,
    now
  );
}

export function updateUserProfile(
  userId: string,
  input: {
    email: string;
    fullName: string;
    location: string;
    currentLocation: string;
    phone: string;
    linkedinUrl: string;
    preferredCompRange: string;
    coverLetterTemplate?: string;
    website: string;
    workHistory: string;
    skills: string;
  }
) {
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE users SET email = ?, full_name = ?, location = ?, current_location = ?, phone = ?, linkedin_url = ?, preferred_comp_range = ?, cover_letter_template = ?, website = ?, work_history = ?, skills = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    input.email.toLowerCase(),
    input.fullName,
    input.location,
    input.currentLocation,
    input.phone,
    input.linkedinUrl,
    input.preferredCompRange,
    input.coverLetterTemplate ?? "",
    input.website,
    input.workHistory,
    input.skills,
    now,
    userId
  );
}

export function updateUserEssay(userId: string, essay: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(`UPDATE users SET essay = ?, updated_at = ? WHERE id = ?`).run(essay, now, userId);
}

export function updateUserCoverLetterTemplate(userId: string, coverLetterTemplate: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(`UPDATE users SET cover_letter_template = ?, updated_at = ? WHERE id = ?`).run(
    coverLetterTemplate,
    now,
    userId
  );
}

export function getFirstUserId(): string | null {
  const db = getSqlite();
  const row = db.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get() as { id: string } | undefined;
  return row?.id ?? null;
}
