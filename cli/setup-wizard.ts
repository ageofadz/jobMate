import { confirm, editor, input, select } from "@inquirer/prompts";

import { getUserProfile, updateUserProfile } from "../lib/data";
import { defaultChromeExtensionOutputDir, installChromeExtensionBundle, openChromeExtensionInstallPage } from "../lib/chrome-extension/install";
import { translate } from "../lib/i18n";
import {
  getChromeExtensionOutputDir,
  isInitialSetupComplete,
  setSetting,
  SETTING_CHROME_EXTENSION_OUTPUT_DIR,
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL,
  SETTING_INITIAL_SETUP_COMPLETE,
  SETTING_LANGUAGE,
  SETTING_NOTIFICATION_WEBHOOK_URL,
  SETTING_SERPAPI_API_KEY
} from "../lib/settings-store";

export async function runInitialSetupWizardIfNeeded(userId: string) {
  if (isInitialSetupComplete()) {
    return;
  }

  process.stdout.write(`\n${translate("firstTimeSetup")}\n\n`);

  const language = await select<"en" | "fr">({
    message: translate("language"),
    choices: [
      { name: translate("english"), value: "en" },
      { name: translate("french"), value: "fr" }
    ],
    default: "en"
  });

  setSetting(SETTING_LANGUAGE, language);

  const serp = await input({
    message: translate("serpApiKeyLong"),
    default: ""
  });

  const gemini = await input({
    message: translate("geminiApiKeyLong"),
    default: ""
  });

  const model = await input({
    message: translate("geminiModel"),
    default: "gemini-3-flash-preview"
  });

  const webhook = await input({
    message: translate("webhookDigestOptional"),
    default: ""
  });

  const profile = getUserProfile(userId);

  if (!profile) {
    throw new Error(translate("missingUserProfile"));
  }

  const website = (await input({
    message: translate("websitePrompt"),
    default: profile.website ?? ""
  })).trim();

  const currentLocation = (await input({
    message: translate("locationPrompt"),
    default: profile.currentLocation ?? profile.location ?? ""
  })).trim();

  const phone = (await input({
    message: translate("phonePrompt"),
    default: profile.phone ?? ""
  })).trim();

  const linkedinUrl = (await input({
    message: translate("linkedinPrompt"),
    default: profile.linkedinUrl ?? ""
  })).trim();

  const preferredCompRange = (await input({
    message: translate("preferredCompPrompt"),
    default: profile.preferredCompRange ?? ""
  })).trim();

  const coverLetterTemplate = (
    await editor({
      message: translate("coverLetterTemplatePrompt"),
      default: profile.coverLetterTemplate ?? ""
    })
  ).trim();

  const skills = (await input({
    message: translate("skillsPrompt"),
    default: profile.skills ?? ""
  })).trim();

  const chromeExtensionOutputDir = getChromeExtensionOutputDir()?.trim() || defaultChromeExtensionOutputDir();

  const installChromeExtension = await confirm({
    message: translate("exportChromeExtensionNow"),
    default: true
  });

  setSetting(SETTING_SERPAPI_API_KEY, serp.trim());
  setSetting(SETTING_GEMINI_API_KEY, gemini.trim());
  setSetting(SETTING_GEMINI_MODEL, model.trim() || "gemini-3-flash-preview");
  setSetting(SETTING_NOTIFICATION_WEBHOOK_URL, webhook.trim());
  setSetting(SETTING_CHROME_EXTENSION_OUTPUT_DIR, chromeExtensionOutputDir);
  setSetting(SETTING_INITIAL_SETUP_COMPLETE, "1");

  updateUserProfile(userId, {
    email: profile.email,
    fullName: profile.fullName ?? "",
    location: currentLocation,
    currentLocation,
    phone,
    linkedinUrl,
    preferredCompRange,
    coverLetterTemplate,
    website,
    workHistory: profile.workHistory ?? "",
    skills
  });

  if (installChromeExtension) {
    installChromeExtensionBundle(chromeExtensionOutputDir);
    process.stdout.write(`\n${translate("chromeInstalled", { dir: chromeExtensionOutputDir }, language)}\n`);
    process.stdout.write(`${translate("chromeGuide", undefined, language)}\n\n`);
    await openChromeExtensionInstallPage();
  }

  process.stdout.write("\nSaved.\n\n");
}
