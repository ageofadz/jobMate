import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openUrlsInChromeWindow } from "@/lib/open-chrome";
import { resolveAppPath } from "@/lib/runtime-paths";

export function defaultChromeExtensionOutputDir() {
  return path.join(os.homedir(), "Downloads", "jobmate-chrome-extension");
}

export function installChromeExtensionBundle(outputDir: string) {
  const sourceDir = resolveAppPath("chrome-extension");

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Chrome extension source directory does not exist: ${sourceDir}`);
  }

  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true });
}

export async function openChromeExtensionInstallPage() {
  await openUrlsInChromeWindow(["chrome://extensions/"]);
}
