import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const distSeaDir = path.join(rootDir, "dist", "sea");
const bundlePath = path.join(distSeaDir, "jobmate.mjs");
const blobPath = path.join(distSeaDir, "jobmate.blob");
const seaConfigPath = path.join(rootDir, "sea-config.json");
const execName = process.platform === "win32" ? "jobmate.exe" : "jobmate";
const outputBinaryPath = path.join(distSeaDir, execName);
const betterSqliteSourceDir = path.join(rootDir, "node_modules", "better-sqlite3");
const betterSqliteTargetDir = path.join(distSeaDir, "node_modules", "better-sqlite3");
const chromeExtensionSourceDir = path.join(rootDir, "chrome-extension");
const chromeExtensionTargetDir = path.join(distSeaDir, "chrome-extension");

if (!fs.existsSync(bundlePath)) {
  throw new Error(`SEA bundle is missing: ${bundlePath}`);
}

if (!fs.existsSync(betterSqliteSourceDir)) {
  throw new Error(`better-sqlite3 is missing from node_modules: ${betterSqliteSourceDir}`);
}

if (!fs.existsSync(chromeExtensionSourceDir)) {
  throw new Error(`chrome-extension directory is missing: ${chromeExtensionSourceDir}`);
}

fs.mkdirSync(distSeaDir, { recursive: true });
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
  cwd: rootDir,
  stdio: "inherit"
});

fs.copyFileSync(process.execPath, outputBinaryPath);
fs.rmSync(chromeExtensionTargetDir, { recursive: true, force: true });
fs.cpSync(chromeExtensionSourceDir, chromeExtensionTargetDir, { recursive: true });
fs.mkdirSync(path.dirname(betterSqliteTargetDir), { recursive: true });
fs.rmSync(betterSqliteTargetDir, { recursive: true, force: true });
fs.cpSync(betterSqliteSourceDir, betterSqliteTargetDir, { recursive: true });

const postjectArgs = [
  outputBinaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
];

if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}

execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "postject", ...postjectArgs], {
  cwd: rootDir,
  stdio: "inherit"
});

if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", "--force", outputBinaryPath], {
    cwd: rootDir,
    stdio: "inherit"
  });
}

if (process.platform !== "win32") {
  fs.chmodSync(outputBinaryPath, 0o755);
}
