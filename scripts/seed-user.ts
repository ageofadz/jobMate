import { randomUUID } from "node:crypto";

import { ensureIndexes, getSqlite } from "../lib/db";
import { getEnv } from "../lib/env";

async function main() {
  const email = process.env.JOBMATE_SEED_EMAIL?.trim().toLowerCase();
  const fullName = process.env.JOBMATE_SEED_FULL_NAME?.trim();

  if (!email || !fullName) {
    process.stderr.write("Set JOBMATE_SEED_EMAIL and JOBMATE_SEED_FULL_NAME before running this script.\n");
    process.exit(1);
  }

  const location = process.env.JOBMATE_SEED_LOCATION?.trim() ?? "";
  const currentLocation = process.env.JOBMATE_SEED_CURRENT_LOCATION?.trim() || location;
  const phone = process.env.JOBMATE_SEED_PHONE?.trim() ?? "";
  const linkedinUrl = process.env.JOBMATE_SEED_LINKEDIN_URL?.trim() ?? "";
  const preferredCompRange = process.env.JOBMATE_SEED_PREFERRED_COMP_RANGE?.trim() ?? "";
  const coverLetterTemplate = process.env.JOBMATE_SEED_COVER_LETTER_TEMPLATE?.trim() ?? "";
  const website = process.env.JOBMATE_SEED_WEBSITE?.trim() ?? "";
  const workHistory = process.env.JOBMATE_SEED_WORK_HISTORY?.trim() ?? "";
  const skills = process.env.JOBMATE_SEED_SKILLS?.trim() ?? "";
  const essay = process.env.JOBMATE_SEED_ESSAY?.trim() ?? "";

  getEnv();
  await ensureIndexes();

  const db = getSqlite();
  const count = (db.prepare(`SELECT COUNT(*) as c FROM users`).get() as { c: number }).c;

  if (count > 0) {
    process.stderr.write("Users table is not empty; refuse to seed.\n");
    process.exit(1);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, full_name, location, current_location, phone, linkedin_url, preferred_comp_range, cover_letter_template, website, work_history, skills, essay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    email,
    fullName,
    location,
    currentLocation,
    phone,
    linkedinUrl,
    preferredCompRange,
    coverLetterTemplate,
    website,
    workHistory,
    skills,
    essay,
    now,
    now
  );

  process.stdout.write(`Seeded local profile for ${email}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exit(1);
});
