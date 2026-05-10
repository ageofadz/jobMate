import { countPreferencesForUser } from "../lib/data";
import { insertPreferenceFromPrompts } from "./preference-prompts";

export async function runPreferenceWizardIfNeeded(userId: string) {
  if (countPreferencesForUser(userId) > 0) {
    return;
  }

  process.stdout.write("\nNo job search preferences yet. Enter your first target.\n\n");

  await insertPreferenceFromPrompts(userId);

  process.stdout.write("\nPreference saved.\n\n");
}
