import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

const envSchema = z.object({
  './data': z.string().min(1).default("./data")
});

let cachedEnv: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
    const root = path.resolve(process.cwd());
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "files"), { recursive: true });
    cachedEnv = { ...cachedEnv, './data': root };
  }

  return cachedEnv;
}

export function getSqlitePath() {
  return path.join(getFilesDir(), "jobmate.sqlite");
}

export function getFilesDir() {
  return path.join('./data');
}
