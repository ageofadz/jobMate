import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeApplyUrl } from "@/lib/apply-url";
import {
  formatProfileForPrompt,
  getAssetUploadInfo,
  getJobById,
  getUserProfile,
  loadResumePdfPayload,
  loadResumeText,
  markJobApplied
} from "@/lib/data";
import { getEnv, getFilesDir } from "@/lib/env";
import { registerChromeApplyPayload, type ChromeApplyPayload } from "@/lib/chrome-extension/payload-server";
import { openUrlsInChromeWindow } from "@/lib/open-chrome";

function base64(buffer: Buffer) {
  return buffer.toString("base64");
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function answerPageHtml(payload: Omit<ChromeApplyPayload, "answerPageHtml">) {
  const linkedInLinks = payload.linkedinLinks
    .map((link) => `<li><a href="${htmlEscape(link)}" target="_blank">${htmlEscape(link)}</a></li>`)
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>JobMate Answers</title>
  <style>
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 20px; color: #17202a; }
    pre { white-space: pre-wrap; background: #f6f8fa; padding: 12px; border-radius: 6px; }
    li { margin: 4px 0; }
    .muted { color: #637083; }
  </style>
</head>
<body>
  <h1>${htmlEscape(payload.company)} - ${htmlEscape(payload.title)}</h1>
  <p class="muted">The extension will update this page after it reads the live form labels.</p>
  <h2>Cover Letter</h2>
  <pre id="cover">${htmlEscape(payload.coverLetterText || "Only generated if the live form asks for a cover letter.")}</pre>
  <h2>Live Form Answers</h2>
  <pre id="answers">Waiting for the extension to read the form...</pre>
  <h2>LinkedIn</h2>
  <ul>${linkedInLinks || "<li>None found</li>"}</ul>
  <script>
    async function poll() {
      const res = await fetch("/answers/${payload.id}");
      const data = await res.json();
      const answers = data.answers || [];
      document.getElementById("cover").textContent = data.coverLetterText || "Only generated if the live form asks for a cover letter.";
      document.getElementById("answers").textContent = answers.length
        ? answers.map(a => a.fieldId + "\\n" + a.answer + "\\n" + a.reasoning).join("\\n\\n")
        : "Waiting for the extension to read the form...";
    }
    setInterval(poll, 1500);
    poll();
  </script>
</body>
</html>`;
}

export async function runApplyJobChromeExtension(jobId: string, userId: string) {
  getEnv();
  const job = await getJobById(userId, jobId);
  const profile = getUserProfile(userId);

  if (!job) {
    throw new Error("Job not found");
  }

  const profileBlock = profile ? formatProfileForPrompt(profile) : "";
  const resumeAssetId = job.resumeAssetId ? String(job.resumeAssetId) : null;
  const resumeText = await loadResumeText(userId, resumeAssetId);
  const resumePayload = loadResumePdfPayload(userId, resumeAssetId);
  const listingText = String(job.listingText ?? "");
  const company = String(job.company ?? "");
  const title = String(job.sourceTitle ?? "");
  const coverTextPath = path.join(getFilesDir(), "cover.txt");

  let resumeUpload: ChromeApplyPayload["resumeUpload"] = null;

  if (resumePayload) {
    resumeUpload = {
      name: resumePayload.filename,
      mimeType: resumePayload.mimeType,
      base64: base64(resumePayload.buffer)
    };
  } else if (resumeAssetId) {
    const info = await getAssetUploadInfo(resumeAssetId, userId);

    if (info && fs.existsSync(info.absolutePath)) {
      resumeUpload = {
        name: info.filename,
        mimeType: info.mimeType,
        base64: base64(fs.readFileSync(info.absolutePath))
      };
    }
  }

  const id = randomUUID();
  const contacts = (Array.isArray(job.hiringContacts) ? job.hiringContacts : []).map((x) => String(x)).filter(Boolean);
  const partialPayload = {
    id,
    jobId,
    title,
    company,
    companyHomepage: String(job.companyHomepage ?? ""),
    applyUrl: normalizeApplyUrl(String(job.applyUrl)),
    contextBlock: profileBlock,
    listingText,
    resumeText,
    writingSample: profile?.essay ?? "",
    coverLetterTemplate: profile?.coverLetterTemplate ?? "",
    coverLetterText: "",
    resumeUpload,
    coverUpload: null,
    linkedinLinks: (Array.isArray(job.linkedinLinks) ? job.linkedinLinks : []).map((x) => String(x)).filter(Boolean),
    hiringContacts: contacts
  };
  const payload: ChromeApplyPayload = {
    ...partialPayload,
    answerPageHtml: answerPageHtml(partialPayload)
  };
  const urls = await registerChromeApplyPayload(payload, (info) => {
    markJobApplied(userId, jobId, { applicationUrl: info?.applicationUrl });
  });
  const applyUrl = new URL(payload.applyUrl);
  applyUrl.hash = `jobmatePayload=${encodeURIComponent(urls.payloadUrl)}`;
  await openUrlsInChromeWindow([
    applyUrl.toString(),
    urls.answerPageUrl,
    ...payload.linkedinLinks.slice(0, 5)
  ]);

  return {
    payloadUrl: urls.payloadUrl,
    answerPageUrl: urls.answerPageUrl,
    coverTextPath
  };
}
