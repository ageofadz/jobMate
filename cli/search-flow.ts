import { select } from "@inquirer/prompts";

import { listJobsNotApplied } from "../lib/data";
import { runApplyJobChromeExtension } from "../lib/chrome-extension/apply-job";
import { runIngestion } from "../lib/services/ingest";
import { runPreferenceWizardIfNeeded } from "./preference-wizard";

export async function runSearchAndApplyFlow(userId: string) {
  await runPreferenceWizardIfNeeded(userId);

  process.stdout.write("Searching listings and generating application drafts...\n\n");

  const result = await runIngestion({ userId, perTargetLimit: 100 });

  process.stdout.write(`Done. Retrieved ${result.retrieved}; added ${result.createdJobs} new job row(s) in this run.\n\n`);

  while (true) {
    const jobs = listJobsNotApplied(userId);

    if (!jobs.length) {
      process.stdout.write("No open jobs left to apply to.\n");
      break;
    }

    const choice = await select({
      message:
        "Pick a job to open in Chrome with the JobMate extension. JobMate fills detected fields and attaches files where possible.",
      choices: [
        ...jobs.map((j) => ({
          name: `${String(j.sourceTitle)} — ${String(j.company)} (${String(j.sourceHost)})`,
          value: String(j._id)
        })),
        { name: "Back to main menu", value: "__back__" }
      ]
    });

    if (choice === "__back__") {
      break;
    }

    process.stdout.write("\nOpening Chrome with JobMate extension...\n");

    await runApplyJobChromeExtension(choice, userId);

    process.stdout.write("\nFinished.\n\n");
  }
}
