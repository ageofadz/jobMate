import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { getEnv, getSqlitePath } from "@/lib/env";

declare global {
  var __jobmateSqlite: Database.Database | undefined;
}

function migrateUsersSchema(db: Database.Database) {
  const readNames = () =>
    new Set(
      (db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>).map((row) => row.name)
    );

  let names = readNames();

  if (names.has("password_hash")) {
    db.exec(`
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE users_migrated (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  location TEXT,
  current_location TEXT,
  phone TEXT,
  linkedin_url TEXT,
  preferred_comp_range TEXT,
  cover_letter_template TEXT,
  website TEXT,
  work_history TEXT,
  skills TEXT,
  essay TEXT,
  resume_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO users_migrated (id, email, full_name, location, current_location, phone, linkedin_url, preferred_comp_range, cover_letter_template, website, work_history, skills, essay, resume_asset_id, created_at, updated_at)
SELECT id, email, name, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_migrated RENAME TO users;
COMMIT;
PRAGMA foreign_keys=ON;
`);
    names = readNames();
  }

  if (!names.has("full_name")) {
    db.exec(`ALTER TABLE users ADD COLUMN full_name TEXT`);
    names.add("full_name");
  }

  if (!names.has("location")) {
    db.exec(`ALTER TABLE users ADD COLUMN location TEXT`);
    names.add("location");
  }

  if (!names.has("current_location")) {
    db.exec(`ALTER TABLE users ADD COLUMN current_location TEXT`);
    names.add("current_location");
    db.prepare(`UPDATE users SET current_location = location WHERE current_location IS NULL AND location IS NOT NULL`).run();
  }

  if (!names.has("phone")) {
    db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
    names.add("phone");
  }

  if (!names.has("linkedin_url")) {
    db.exec(`ALTER TABLE users ADD COLUMN linkedin_url TEXT`);
    names.add("linkedin_url");
  }

  if (!names.has("preferred_comp_range")) {
    db.exec(`ALTER TABLE users ADD COLUMN preferred_comp_range TEXT`);
    names.add("preferred_comp_range");
  }

  if (!names.has("cover_letter_template")) {
    db.exec(`ALTER TABLE users ADD COLUMN cover_letter_template TEXT`);
    names.add("cover_letter_template");
  }

  if (!names.has("work_history")) {
    db.exec(`ALTER TABLE users ADD COLUMN work_history TEXT`);
    names.add("work_history");
  }

  if (!names.has("skills")) {
    db.exec(`ALTER TABLE users ADD COLUMN skills TEXT`);
    names.add("skills");
  }

  if (!names.has("website")) {
    db.exec(`ALTER TABLE users ADD COLUMN website TEXT`);
    names.add("website");
  }

  if (!names.has("essay")) {
    db.exec(`ALTER TABLE users ADD COLUMN essay TEXT`);
    names.add("essay");
  }

  names = readNames();

  if (names.has("name")) {
    db.prepare(`UPDATE users SET full_name = trim(COALESCE(NULLIF(trim(full_name), ''), name))`).run();
  }
}

const MIGRATE = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  location TEXT,
  current_location TEXT,
  phone TEXT,
  linkedin_url TEXT,
  preferred_comp_range TEXT,
  cover_letter_template TEXT,
  website TEXT,
  work_history TEXT,
  skills TEXT,
  essay TEXT,
  resume_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  locations TEXT NOT NULL,
  board_domains TEXT NOT NULL,
  keyword_seed TEXT NOT NULL,
  generated_keywords TEXT NOT NULL,
  search_queries TEXT NOT NULL,
  search_after_days INTEGER NOT NULL DEFAULT 14,
  context_block TEXT NOT NULL,
  timezone TEXT NOT NULL,
  schedule_hour_local INTEGER NOT NULL,
  resume_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_text TEXT,
  file_blob BLOB,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  preference_id TEXT NOT NULL,
  digest_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_host TEXT NOT NULL,
  source_title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  compensation_range TEXT,
  company_homepage TEXT,
  linkedin_links TEXT NOT NULL DEFAULT '[]',
  hiring_contacts TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  listing_text TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  fields TEXT NOT NULL,
  resume_asset_id TEXT,
  cover_letter_asset_id TEXT,
  status TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  applied_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, source_url)
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  job_ids TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_preferences_user ON preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_digest ON jobs(user_id, digest_date);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status, discovered_at);
CREATE INDEX IF NOT EXISTS idx_assets_user_kind ON assets(user_id, kind);

CREATE TABLE IF NOT EXISTS kv_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unparsed_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  preference_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_host TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  last_error TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_unparsed_jobs_user_pref ON unparsed_jobs(user_id, preference_id, retrieved_at);
`;

let indexesEnsured = false;

function ensureColumn(db: Database.Database, table: string, column: string, ddl: string) {
  const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));

  if (!names.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrateApplicationSchema(db: Database.Database) {
  ensureColumn(db, "users", "current_location", "current_location TEXT");
  ensureColumn(db, "users", "phone", "phone TEXT");
  ensureColumn(db, "users", "linkedin_url", "linkedin_url TEXT");
  ensureColumn(db, "users", "preferred_comp_range", "preferred_comp_range TEXT");
  ensureColumn(db, "users", "cover_letter_template", "cover_letter_template TEXT");
  db.prepare(`UPDATE users SET current_location = location WHERE current_location IS NULL AND location IS NOT NULL`).run();
  ensureColumn(db, "preferences", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "preferences", "search_after_days", "search_after_days INTEGER NOT NULL DEFAULT 14");
  ensureColumn(db, "jobs", "compensation_range", "compensation_range TEXT");
  ensureColumn(db, "jobs", "company_homepage", "company_homepage TEXT");
  ensureColumn(db, "jobs", "linkedin_links", "linkedin_links TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "jobs", "hiring_contacts", "hiring_contacts TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "jobs", "archived_at", "archived_at TEXT");
  ensureColumn(db, "jobs", "applied_application_url", "applied_application_url TEXT");
  ensureColumn(db, "jobs", "applied_at_hiring_contacts", "applied_at_hiring_contacts TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "jobs", "applied_at_linkedin_links", "applied_at_linkedin_links TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "assets", "file_blob", "file_blob BLOB");
  ensureColumn(db, "users", "resume_asset_id", "resume_asset_id TEXT");

  db.exec(`CREATE TABLE IF NOT EXISTS unparsed_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preference_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_host TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    last_error TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, source_url)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_unparsed_jobs_user_pref ON unparsed_jobs(user_id, preference_id, retrieved_at)`);

  const marker = db.prepare(`SELECT 1 AS x FROM kv_settings WHERE key = ?`).get("jobmate_resume_profile_backfill");

  if (!marker) {
    db.exec(`
UPDATE users
SET resume_asset_id = (
  SELECT p.resume_asset_id FROM preferences p
  WHERE p.user_id = users.id AND p.resume_asset_id IS NOT NULL
  ORDER BY p.updated_at DESC
  LIMIT 1
)
WHERE resume_asset_id IS NULL
AND EXISTS (
  SELECT 1 FROM preferences p WHERE p.user_id = users.id AND p.resume_asset_id IS NOT NULL
);
`);
    db.prepare(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`).run("jobmate_resume_profile_backfill", "1");
  }
}

export function getSqlite(): Database.Database {
  if (!global.__jobmateSqlite) {
    const fp = getSqlitePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    global.__jobmateSqlite = new Database(fp);
    global.__jobmateSqlite.exec(MIGRATE);
    migrateUsersSchema(global.__jobmateSqlite);
    migrateApplicationSchema(global.__jobmateSqlite);
  }

  return global.__jobmateSqlite;
}

export async function getDb() {
  getEnv();
  return getSqlite();
}

export async function ensureIndexes() {
  if (indexesEnsured) {
    return;
  }

  getSqlite();
  indexesEnsured = true;
}
