import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openUrlsInChromeWindow(urls: string[]) {
  const cleanUrls = urls.map((url) => new URL(url).toString());

  if (!cleanUrls.length) {
    return;
  }

  if (process.platform === "darwin") {
    const lines = [
      `tell application "Google Chrome"`,
      `activate`,
      `set newWindow to make new window`,
      `set URL of active tab of newWindow to ${JSON.stringify(cleanUrls[0])}`,
      ...cleanUrls.slice(1).map((url) => `make new tab at end of tabs of newWindow with properties {URL:${JSON.stringify(url)}}`),
      `end tell`
    ];
    await execFileAsync("osascript", lines.flatMap((line) => ["-e", line]));
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "chrome", "--new-window", ...cleanUrls]);
    return;
  }

  await execFileAsync("google-chrome", ["--new-window", ...cleanUrls]).catch(() =>
    execFileAsync("chromium", ["--new-window", ...cleanUrls])
  );
}
