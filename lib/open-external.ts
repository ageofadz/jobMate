import { execFileSync } from "node:child_process";

export function openUrlInDefaultBrowser(url: string) {
  const href = new URL(url).href;

  if (process.platform === "darwin") {
    execFileSync("open", [href], { stdio: "ignore" });
  } else if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "start", "", href], { stdio: "ignore" });
  } else {
    execFileSync("xdg-open", [href], { stdio: "ignore" });
  }
}
