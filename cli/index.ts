import { ensureIndexes } from "../lib/db";
import { getEnv } from "../lib/env";
import { runDashboard } from "./dashboard/run-dashboard";
import { installGlobalErrorHooks, reportError } from "./report-error";
import { resolveLocalUserId } from "./local-user";
import { runInitialSetupWizardIfNeeded } from "./setup-wizard";

installGlobalErrorHooks();

async function main() {
  getEnv();
  await ensureIndexes();

  const userId = await resolveLocalUserId();
  await runInitialSetupWizardIfNeeded(userId);
  await runDashboard(userId);
}

main().catch((err: unknown) => {
  reportError("Fatal error in main()", err);
  process.exit(1);
});
