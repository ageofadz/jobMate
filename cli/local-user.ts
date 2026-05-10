import { randomUUID } from "node:crypto";

import { editor, input } from "@inquirer/prompts";

import { getFirstUserId, insertUserProfile } from "../lib/data";
import { translate } from "../lib/i18n";

export async function resolveLocalUserId(): Promise<string> {
  const existing = getFirstUserId();

  if (existing) {
    return existing;
  }

  process.stdout.write(`\n${translate("yourProfileStoredLocally")}\n\n`);

  const fullName = (await input({ message: translate("fullNamePrompt") })).trim();
  const email = (await input({ message: translate("emailPrompt") })).trim().toLowerCase();
  const currentLocation = (await input({ message: translate("locationPrompt") })).trim();
  const phone = (await input({ message: translate("phonePrompt") })).trim();
  const linkedinUrl = (await input({ message: translate("linkedinPrompt") })).trim();
  const preferredCompRange = (await input({ message: translate("preferredCompPrompt") })).trim();

  if (!fullName || !email) {
    throw new Error(translate("fullNameEmailRequired"));
  }

  const workHistory = (await editor({
    message: translate("workHistoryPrompt"),
    default: ""
  })).trim();

  const id = randomUUID();

  insertUserProfile({
    id,
    email,
    fullName,
    location: currentLocation,
    currentLocation,
    phone,
    linkedinUrl,
    preferredCompRange,
    website: "",
    workHistory,
    skills: "",
    essay: ""
  });

  process.stdout.write(`\n${translate("profileSaved")}\n\n`);

  return id;
}

export async function promptProfileFields(defaults?: {
  email: string;
  fullName: string;
  location: string;
  currentLocation: string;
  phone: string;
  linkedinUrl: string;
  preferredCompRange: string;
  coverLetterTemplate: string;
  website: string;
  workHistory: string;
  skills: string;
}) {
  const fullName = (await input({ message: translate("fullNamePrompt"), default: defaults?.fullName ?? "" })).trim();
  const email = (await input({ message: translate("emailPrompt"), default: defaults?.email ?? "" })).trim().toLowerCase();
  const currentLocation = (await input({
    message: translate("locationPrompt"),
    default: defaults?.currentLocation || defaults?.location || ""
  })).trim();
  const phone = (await input({ message: translate("phonePrompt"), default: defaults?.phone ?? "" })).trim();
  const linkedinUrl = (await input({ message: translate("linkedinPrompt"), default: defaults?.linkedinUrl ?? "" })).trim();
  const preferredCompRange = (await input({
    message: translate("preferredCompPrompt"),
    default: defaults?.preferredCompRange ?? ""
  })).trim();
  const coverLetterTemplate = defaults?.coverLetterTemplate ?? "";
  const location = currentLocation;
  const website = (await input({
    message: translate("websiteShortPrompt"),
    default: defaults?.website ?? ""
  })).trim();

  if (!fullName || !email) {
    throw new Error(translate("fullNameEmailRequired"));
  }

  const workHistory = (await editor({
    message: translate("workHistoryPrompt"),
    default: defaults?.workHistory ?? ""
  })).trim();

  const skills = (await input({
    message: translate("skillsPrompt"),
    default: defaults?.skills ?? ""
  })).trim();

  return {
    fullName,
    email,
    location,
    currentLocation,
    phone,
    linkedinUrl,
    preferredCompRange,
    coverLetterTemplate,
    website,
    workHistory,
    skills
  };
}
