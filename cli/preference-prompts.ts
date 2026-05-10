import { CancelPromptError, ExitPromptError } from "@inquirer/core";
import { input } from "@inquirer/prompts";

import { createResumeAssetFromPath, insertPreference, updatePreference } from "../lib/data";
import { translate } from "../lib/i18n";
import { reportError } from "./report-error";
import { preferenceInputSchema } from "../lib/validators";
import type { PreferenceInput } from "../lib/validators";

export async function promptPreferenceInput(userId: string, defaults?: Partial<PreferenceInput>) {
  const title = await input({
    message: translate("targetRoleTitle"),
    default: defaults?.title ?? "Staff Engineer"
  });

  const locationsRaw = await input({
    message: translate("locationsPrompt"),
    default: defaults?.locations?.join(", ") ?? "Chicago"
  });

  const boardDomainsRaw = await input({
    message: translate("boardDomainsPrompt"),
    default: defaults?.boardDomains?.join(", ") ?? "boards.greenhouse.io, lever.co"
  });

  const keywordSeedRaw = await input({
    message: translate("keywordSeedsPrompt"),
    default: defaults?.keywordSeed?.join(", ") ?? ""
  });

  const searchAfterDaysRaw = await input({
    message: translate("googleAfterPrompt"),
    default: String(defaults?.searchAfterDays ?? 14),
    validate: (v) => {
      const n = Number(v);

      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return translate("integerRange1to365");
      }

      return true;
    }
  });

  const timezone = await input({
    message: translate("timezonePrompt"),
    default: defaults?.timezone ?? "America/Chicago"
  });

  const scheduleHourRaw = await input({
    message: translate("scheduleHourPrompt"),
    default: String(defaults?.scheduleHourLocal ?? 9),
    validate: (v) => {
      const n = Number(v);

      if (!Number.isInteger(n) || n < 0 || n > 23) {
        return translate("integerRange0to23");
      }

      return true;
    }
  });

  let resumeAssetId: string | null | undefined = defaults?.resumeAssetId ?? null;

  const hasExistingResume = defaults?.resumeAssetId != null && defaults.resumeAssetId !== "";

  for (;;) {
    const resumePrompt = await input({
      message: hasExistingResume
        ? translate("resumePathKeep")
        : translate("resumePathOptional"),
      default: ""
    });

    if (!resumePrompt.trim()) {
      break;
    }

    try {
      resumeAssetId = await createResumeAssetFromPath(userId, resumePrompt.trim());
      break;
    } catch (err) {
      reportError("Resume PDF path failed", err);
      process.stdout.write(
        hasExistingResume
          ? `${translate("resumeTryAnotherKeep")}\n\n`
          : `${translate("resumeTryAnotherSkip")}\n\n`
      );
    }
  }

  return preferenceInputSchema.parse({
    title,
    locations: locationsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    boardDomains: boardDomainsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    keywordSeed: keywordSeedRaw
      ? keywordSeedRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    searchAfterDays: Number(searchAfterDaysRaw),
    contextBlock: "",
    timezone,
    scheduleHourLocal: Number(scheduleHourRaw),
    resumeAssetId: resumeAssetId ?? null
  });
}

export async function insertPreferenceFromPrompts(userId: string) {
  try {
    const payload = await promptPreferenceInput(userId);
    insertPreference(userId, payload);
  } catch (err) {
    if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
      return;
    }

    reportError("insertPreferenceFromPrompts", err);
  }
}

export async function updatePreferenceFromPrompts(userId: string, preferenceId: string, defaults: Record<string, unknown>) {
  try {
    const mapped: Partial<PreferenceInput> = {
      title: String(defaults.title ?? ""),
      locations: defaults.locations as string[],
      boardDomains: defaults.boardDomains as string[],
      keywordSeed: (defaults.keywordSeed as string[]) ?? [],
      searchAfterDays: Number(defaults.searchAfterDays ?? 14),
      timezone: String(defaults.timezone ?? "America/Chicago"),
      scheduleHourLocal: Number(defaults.scheduleHourLocal ?? 9),
      resumeAssetId: (defaults.resumeAssetId as string | null | undefined) ?? null
    };

    const payload = await promptPreferenceInput(userId, mapped);
    updatePreference(userId, preferenceId, payload);
  } catch (err) {
    if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
      return;
    }

    reportError("updatePreferenceFromPrompts", err);
  }
}
