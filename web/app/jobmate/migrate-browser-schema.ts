type SqlJsDatabase = {
  prepare: (sql: string) => SqlJsStatement;
  run: (sql: string) => void;
};

type SqlJsStatement = {
  bind(values: string[]): boolean;
  step: () => boolean;
  getAsObject: () => Record<string, unknown>;
  free: () => void;
};

function tableColumns(db: SqlJsDatabase, table: string) {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  const names = new Set<string>();
  while (stmt.step()) {
    names.add(String(stmt.getAsObject().name));
  }
  stmt.free();
  return names;
}

function ensureColumn(db: SqlJsDatabase, table: string, column: string, ddl: string) {
  const names = tableColumns(db, table);
  if (!names.has(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function kvHas(db: SqlJsDatabase, key: string): boolean {
  const stmt = db.prepare(`SELECT 1 AS x FROM kv_settings WHERE key = ?`);

  try {
    stmt.bind([key]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}

export function migrateBrowserApplicationSchema(db: SqlJsDatabase) {
  ensureColumn(db, "users", "current_location", "current_location TEXT");
  ensureColumn(db, "users", "phone", "phone TEXT");
  ensureColumn(db, "users", "linkedin_url", "linkedin_url TEXT");
  ensureColumn(db, "users", "preferred_comp_range", "preferred_comp_range TEXT");
  ensureColumn(db, "users", "cover_letter_template", "cover_letter_template TEXT");
  db.run(`UPDATE users SET current_location = location WHERE current_location IS NULL AND location IS NOT NULL`);
  ensureColumn(db, "preferences", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "preferences", "search_after_days", "search_after_days INTEGER NOT NULL DEFAULT 14");
  ensureColumn(db, "preferences", "google_jobs_url", "google_jobs_url TEXT");
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
  ensureColumn(db, "jobs", "email_status", "email_status TEXT");
  ensureColumn(db, "jobs", "posted_at", "posted_at TEXT");
  ensureColumn(db, "jobs", "company_logo_url", "company_logo_url TEXT");

  if (!kvHas(db, "jobmate_resume_profile_backfill")) {
    db.run(`UPDATE users SET resume_asset_id = (
      SELECT p.resume_asset_id FROM preferences p
      WHERE p.user_id = users.id AND p.resume_asset_id IS NOT NULL
      ORDER BY p.updated_at DESC LIMIT 1
    ) WHERE resume_asset_id IS NULL AND EXISTS (
      SELECT 1 FROM preferences p WHERE p.user_id = users.id AND p.resume_asset_id IS NOT NULL
    )`);
    db.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES ('jobmate_resume_profile_backfill', '1')`);
  }
}
