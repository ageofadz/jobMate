import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";

import { getFilesDir } from "@/lib/env";

function safeFileName(filename: string) {
  return path.basename(filename).replace(/[^\w .()-]+/g, "-").replace(/\s+/g, " ").trim();
}

export function writeUploadedFile(buffer: Buffer, preferredFilename?: string) {
  const id = randomUUID();
  const safe = preferredFilename ? safeFileName(preferredFilename) : "";
  const relative = safe || id;
  const abs = path.join(getFilesDir(), relative);

  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, buffer);
    return { id, relativePath: relative, absolutePath: abs };
  }

  const parsed = path.parse(relative);
  const collisionSafe = `${parsed.name}-${id.slice(0, 8)}${parsed.ext}`;
  const collisionAbs = path.join(getFilesDir(), collisionSafe);
  fs.writeFileSync(collisionAbs, buffer);
  return { id, relativePath: collisionSafe, absolutePath: collisionAbs };
}

export function readUploadedFileRelative(relativePath: string) {
  return fs.readFileSync(path.join(getFilesDir(), relativePath));
}
