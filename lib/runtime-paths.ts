import fs from "node:fs";
import path from "node:path";

export function resolveAppRoot() {
  const roots = [process.cwd(), path.dirname(process.execPath)];

  for (const root of roots) {
    if (fs.existsSync(path.join(root, "chrome-extension"))) {
      return root;
    }
  }

  throw new Error(
    `Unable to resolve JobMate app root. Expected chrome-extension beside cwd or executable. cwd=${process.cwd()} exec=${process.execPath}`
  );
}

export function resolveAppPath(...segments: string[]) {
  return path.join(resolveAppRoot(), ...segments);
}
