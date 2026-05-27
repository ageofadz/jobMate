export const JOBMATE_SQLITE_DDL = `
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
  google_jobs_url TEXT,
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
  posted_at TEXT,
  company_logo_url TEXT,
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
`;
