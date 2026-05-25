import { CancelPromptError, ExitPromptError } from "@inquirer/core";
import { input } from "@inquirer/prompts";

import { insertPreference, updatePreference } from "../lib/data";
import { translate } from "../lib/i18n";
import { reportError } from "./report-error";
import { formatLocationsForInput, preferenceInputSchema, splitLocations } from "../lib/validators";
import type { PreferenceInput } from "../lib/validators";

export async function promptPreferenceInput(_userId: string, defaults?: Partial<PreferenceInput>) {
  const title = await input({
    message: translate("targetRoleTitle"),
  });

  const locationsRaw = await input({
    message: translate("locationsPrompt"),
    default: defaults?.locations?.length ? formatLocationsForInput(defaults.locations) : undefined
  });

  const boardDomainsRaw = await input({
    message: translate("boardDomainsPrompt"),
    default:
      defaults?.boardDomains?.join(", ") ??
      "boards.greenhouse.io, lever.co, jobteaser.com, workatastartup.com, smartrecruiters.com"
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

  return preferenceInputSchema.parse({
    title,
    locations: splitLocations(locationsRaw),
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
    scheduleHourLocal: Number(scheduleHourRaw)
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
      scheduleHourLocal: 9
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
