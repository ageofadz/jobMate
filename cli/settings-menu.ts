import { CancelPromptError, ExitPromptError } from "@inquirer/core";
import { confirm, editor, input, select } from "@inquirer/prompts";

import { defaultChromeExtensionOutputDir, installChromeExtensionBundle, openChromeExtensionInstallPage } from "../lib/chrome-extension/install";
import { prepareStdinBeforeExternalPrompts } from "./prepare-stdin-prompts";
import { reportError } from "./report-error";
import {
  attachResumeToAllPreferences,
  createResumeAssetFromPath,
  deletePreference,
  getPreferenceMap,
  getUserProfile,
  listPreferencesMaps,
  updateUserCoverLetterTemplate,
  updateUserEssay,
  updateUserProfile
} from "../lib/data";
import { getEnv, getFilesDir } from "../lib/env";
import {
  getGeminiApiKey,
  getGeminiModel,
  getNotificationWebhookUrl,
  getChromeExtensionOutputDir,
  getLanguageSetting,
  getSerpApiKey,
  setSetting,
  SETTING_CHROME_EXTENSION_OUTPUT_DIR,
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL,
  SETTING_LANGUAGE,
  SETTING_NOTIFICATION_WEBHOOK_URL,
  SETTING_SERPAPI_API_KEY
} from "../lib/settings-store";
import { promptProfileFields } from "./local-user";
import { insertPreferenceFromPrompts, updatePreferenceFromPrompts } from "./preference-prompts";
import { translate } from "../lib/i18n";

export async function runSettingsMenu(userId: string) {
  while (true) {
    const section = await select({
      message: translate("settings"),
      choices: [
        { name: translate("yourProfile"), value: "profile" },
        { name: translate("writingSample"), value: "essay" },
        { name: translate("coverLetterTemplate"), value: "cover" },
        { name: translate("language"), value: "language" },
        { name: translate("chromeExtension"), value: "chrome" },
        { name: translate("apiKeysModels"), value: "api" },
        { name: translate("jobSearchPreferences"), value: "prefs" },
        { name: translate("resumePdfAllSearches"), value: "resume" },
        { name: translate("dataFolder"), value: "data" },
        { name: translate("back"), value: "back" }
      ]
    });

    if (section === "back") {
      return;
    }

    if (section === "profile") {
      await runProfileSettings(userId);
    } else if (section === "essay") {
      await runEssaySettings(userId);
    } else if (section === "cover") {
      await runCoverLetterTemplateSettings(userId);
    } else if (section === "language") {
      await runLanguageSettings();
    } else if (section === "chrome") {
      await runChromeExtensionSettings();
    } else if (section === "api") {
      await runApiSettings();
    } else if (section === "prefs") {
      await runPreferencesSettings(userId);
    } else if (section === "resume") {
      await runResumeSettings(userId);
    } else if (section === "data") {
      process.stdout.write(`\n${translate("dataDirectoryLabel", { dir: getFilesDir() })}\n`);
      process.stdout.write(`${translate("dataDirectoryHelp")}\n\n`);
    }
  }
}

export async function runLanguageSettings() {
  const language = await select<"en" | "fr">({
    message: translate("language"),
    choices: [
      { name: translate("english"), value: "en" },
      { name: translate("french"), value: "fr" }
    ],
    default: getLanguageSetting() === "fr" ? "fr" : "en"
  });

  setSetting(SETTING_LANGUAGE, language);
  process.stdout.write(`${translate("languageSaved")}\n\n`);
}

export async function runChromeExtensionSettings() {
  const outputDir = (await input({
    message: translate("chromeExtensionOutputDirectory"),
    default: getChromeExtensionOutputDir() ?? defaultChromeExtensionOutputDir()
  })).trim();

  if (!outputDir) {
    throw new Error(translate("chromeExtensionOutputRequired"));
  }

  setSetting(SETTING_CHROME_EXTENSION_OUTPUT_DIR, outputDir);
  installChromeExtensionBundle(outputDir);

  process.stdout.write(`${translate("chromeInstalled", { dir: outputDir })}\n`);
  process.stdout.write(`${translate("chromeGuide")}\n\n`);

  const shouldOpenChrome = await confirm({
    message: translate("openChromeNow"),
    default: true
  });

  if (shouldOpenChrome) {
    await openChromeExtensionInstallPage();
  }
}

export async function runProfileSettings(userId: string) {
  const existing = getUserProfile(userId);

  if (!existing) {
    process.stdout.write(`${translate("noProfileRowFound")}\n\n`);
    return;
  }

  const fields = await promptProfileFields({
    email: existing.email,
    fullName: existing.fullName ?? "",
    location: existing.location ?? "",
    currentLocation: existing.currentLocation ?? existing.location ?? "",
    phone: existing.phone ?? "",
    linkedinUrl: existing.linkedinUrl ?? "",
    preferredCompRange: existing.preferredCompRange ?? "",
    coverLetterTemplate: existing.coverLetterTemplate ?? "",
    website: existing.website ?? "",
    workHistory: existing.workHistory ?? "",
    skills: existing.skills ?? ""
  });

  updateUserProfile(userId, fields);
  process.stdout.write(`${translate("profileUpdated")}\n\n`);
}

export async function runEssaySettings(userId: string) {
  const existing = getUserProfile(userId);

  if (!existing) {
    process.stdout.write(`${translate("noProfileRowFound")}\n\n`);
    return;
  }

  const essay = (
    await editor({
      message: translate("writingSample"),
      default: existing.essay ?? ""
    })
  ).trim();

  updateUserEssay(userId, essay);
  process.stdout.write(`${translate("writingSampleSaved")}\n\n`);
}

export async function runCoverLetterTemplateSettings(userId: string) {
  const existing = getUserProfile(userId);

  if (!existing) {
    process.stdout.write(`${translate("noProfileRowFound")}\n\n`);
    return;
  }

  const coverLetterTemplate = (
    await editor({
      message: translate("coverLetterTemplatePromptSettings"),
      default: existing.coverLetterTemplate ?? ""
    })
  ).trim();

  updateUserCoverLetterTemplate(userId, coverLetterTemplate);
  process.stdout.write(`${translate("coverLetterTemplateSaved")}\n\n`);
}

export async function runApiSettings() {
  while (true) {
    const action = await select({
      message: "API keys & models",
      choices: [
        {
          name: `SerpApi key (${mask(getSerpApiKey())})`,
          value: "serp"
        },
        {
          name: `Gemini key (${mask(getGeminiApiKey())})`,
          value: "gemini"
        },
        {
          name: `Gemini model (${getGeminiModel()})`,
          value: "model"
        },
        {
          name: `Notification webhook (${mask(getNotificationWebhookUrl())})`,
          value: "webhook"
        },
        { name: "Back", value: "back" }
      ]
    });

    if (action === "back") {
      return;
    }

    if (action === "serp") {
      const v = await input({
        message: "SerpApi API key",
        default: getSerpApiKey() ?? ""
      });
      setSetting(SETTING_SERPAPI_API_KEY, v.trim());
    } else if (action === "gemini") {
      const v = await input({
        message: "Gemini API key",
        default: getGeminiApiKey() ?? ""
      });
      setSetting(SETTING_GEMINI_API_KEY, v.trim());
    } else if (action === "model") {
      const v = await input({
        message: "Gemini model",
        default: getGeminiModel()
      });
      setSetting(SETTING_GEMINI_MODEL, v.trim() || "gemini-3-flash-preview");
    } else if (action === "webhook") {
      const v = await input({
        message: "Webhook URL (optional)",
        default: getNotificationWebhookUrl() ?? ""
      });
      setSetting(SETTING_NOTIFICATION_WEBHOOK_URL, v.trim());
    }

    process.stdout.write("Saved.\n\n");
  }
}

function mask(v: string | undefined) {
  if (!v) {
    return "not set";
  }

  if (v.length <= 6) {
    return "set";
  }

  return `${v.slice(0, 3)}…${v.slice(-3)}`;
}

async function runPreferencesSettings(userId: string) {
  while (true) {
    const action = await select({
      message: "Job search preferences",
      choices: [
        { name: "Add preference", value: "add" },
        { name: "Edit preference", value: "edit" },
        { name: "Delete preference", value: "del" },
        { name: "Back", value: "back" }
      ]
    });

    if (action === "back") {
      return;
    }

    if (action === "add") {
      await insertPreferenceFromPrompts(userId);
      process.stdout.write("Preference added.\n\n");
    }

    if (action === "edit") {
      const prefs = listPreferencesMaps(userId);

      if (!prefs.length) {
        process.stdout.write("No preferences yet.\n\n");
        continue;
      }

      const pid = await select({
        message: "Which preference?",
        choices: [
          ...prefs.map((p) => ({
            name: `${String(p.title)} (${String((p.locations as string[]).join(", "))})`,
            value: String(p._id)
          })),
          { name: "Cancel", value: "__cancel__" }
        ]
      });

      if (pid === "__cancel__") {
        continue;
      }

      const existing = getPreferenceMap(userId, pid);

      if (!existing) {
        continue;
      }

      await updatePreferenceFromPrompts(userId, pid, existing);
      process.stdout.write("Preference updated.\n\n");
    }

    if (action === "del") {
      const prefs = listPreferencesMaps(userId);

      if (!prefs.length) {
        process.stdout.write("No preferences yet.\n\n");
        continue;
      }

      const pid = await select({
        message: "Delete which preference?",
        choices: [
          ...prefs.map((p) => ({
            name: String(p.title),
            value: String(p._id)
          })),
          { name: "Cancel", value: "__cancel__" }
        ]
      });

      if (pid === "__cancel__") {
        continue;
      }

      const ok = await confirm({
        message: "Delete this preference?",
        default: false
      });

      if (ok) {
        deletePreference(userId, pid);
        process.stdout.write("Deleted.\n\n");
      }
    }
  }
}

export async function runResumeSettings(userId: string) {
  prepareStdinBeforeExternalPrompts();

  for (; ;) {
    let pathRaw: string;

    try {
      pathRaw = await input({
        message: "Path to resume PDF (replaces resume for all your search preferences)",
        default: ""
      });
    } catch (err) {
      if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
        return;
      }

      throw err;
    }

    if (!pathRaw.trim()) {
      process.stdout.write("Cancelled.\n\n");
      return;
    }

    try {
      const assetId = await createResumeAssetFromPath(userId, pathRaw.trim());
      attachResumeToAllPreferences(userId, assetId);
      process.stdout.write("Resume saved and linked to all preferences.\n\n");
      return;
    } catch (err) {
      reportError("Resume PDF could not be loaded", err);
      process.stdout.write("Try another path, or submit an empty path to cancel.\n\n");
    }
  }
}
