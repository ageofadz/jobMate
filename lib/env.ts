import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dataRoot: string | null = null;

function ensureDataLayout() {
  if (dataRoot) {
    return;
  }
  const raw = process.env.JOBMATE_DATA_DIR?.trim();
  if (raw) {
    dataRoot = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  } else if (process.env.VERCEL === "1") {
    dataRoot = path.join(os.tmpdir(), "jobmate-data");
  } else {
    dataRoot = path.join(process.cwd(), "data");
  }
  fs.mkdirSync(dataRoot, { recursive: true });
}

export function getEnv() {
  ensureDataLayout();
  return { "./data": dataRoot! };
}

export function getSqlitePath() {
  ensureDataLayout();
  return path.join(dataRoot!, "jobmate.sqlite");
}

export function getFilesDir() {
  ensureDataLayout();
  return dataRoot!;
}
