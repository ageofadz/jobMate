import fs from "node:fs";
import path from "node:path";

import { getFilesDir } from "@/lib/env";
import { getAppLanguage, type AppLanguage } from "@/lib/i18n";
import { fetchCompanyAboutContext } from "@/lib/services/company-about";
import { classifyApplicationFieldIntent, generateTailoredCoverLetterText } from "@/lib/services/llm";
import { getGeminiApiKey } from "@/lib/settings-store";

export type ApplyFormField = {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

export type CoverLetterApplyPayload = {
  company: string;
  companyHomepage: string;
  title: string;
  contextBlock: string;
  listingText: string;
  resumeText: string;
  writingSample: string;
  coverLetterTemplate: string;
  coverLetterText: string;
  coverUpload: { name: string; mimeType: string; base64: string } | null;
  resumeUpload: { base64: string } | null;
};

export async function fieldsNeedCoverLetter(
  fields: ApplyFormField[],
  gemini?: { apiKey: string; model?: string | null }
) {
  const geminiApiKey = gemini?.apiKey?.trim() || getGeminiApiKey()?.trim();

  if (!geminiApiKey) {
    throw new Error("Gemini API key is required to detect cover letter fields.");
  }

  const intents = await Promise.all(
    fields.map((field) =>
      classifyApplicationFieldIntent({
        label: field.label,
        key: field.key,
        type: field.type,
        options: field.options,
        gemini
      })
    )
  );

  return intents.some((intent) => intent === "cover_letter_upload");
}

export async function ensureChromeApplyCoverLetter(
  payload: CoverLetterApplyPayload,
  fields: ApplyFormField[],
  options: {
    gemini?: { apiKey: string; model?: string | null };
    language?: AppLanguage;
    pageLanguage?: string;
    writeCoverTextFile?: boolean;
  } = {}
) {
  if (payload.coverLetterText?.trim()) {
    return;
  }

  const companyAboutText = await fetchCompanyAboutContext(payload.companyHomepage);
  const resumePdf = payload.resumeUpload?.base64 ? Buffer.from(payload.resumeUpload.base64, "base64") : null;
  const coverLetterText = await generateTailoredCoverLetterText({
    profileBlock: payload.contextBlock,
    resumeText: resumePdf ? undefined : payload.resumeText,
    resumePdf,
    listingText: payload.listingText,
    writingSample: payload.writingSample,
    coverLetterTemplate: payload.coverLetterTemplate,
    companyAboutText,
    company: payload.company,
    roleTitle: payload.title,
    language: options.language ?? getAppLanguage(),
    pageLanguage: options.pageLanguage,
    gemini: options.gemini
  });

  if (options.writeCoverTextFile !== false) {
    fs.writeFileSync(path.join(getFilesDir(), "cover.txt"), coverLetterText, "utf8");
  }

  payload.coverLetterText = coverLetterText;
  payload.coverUpload = {
    name: "cover-letter.txt",
    mimeType: "text/plain",
    base64: Buffer.from(coverLetterText, "utf8").toString("base64")
  };
}
