import { formatProfileForPrompt, getJobById, getUserProfile, loadResumeText } from "@/lib/data";
import { getAppLanguage } from "@/lib/i18n";
import { generateHiringContactEmail } from "@/lib/services/llm";
import { openUrlsInChromeWindow } from "@/lib/open-chrome";

function gmailComposeUrl(params: { to: string; subject: string; body: string }) {
  const url = new URL("https://mail.google.com/mail/");
  url.searchParams.set("view", "cm");
  url.searchParams.set("fs", "1");
  url.searchParams.set("to", params.to);
  url.searchParams.set("su", params.subject);
  url.searchParams.set("body", params.body);
  return url.toString();
}

export async function openFollowUpEmails(userId: string, jobId: string) {
  const job = await getJobById(userId, jobId);
  const profile = getUserProfile(userId);

  if (!job) {
    throw new Error("Job not found.");
  }

  const appliedContacts = Array.isArray(job.appliedAtHiringContacts) ? job.appliedAtHiringContacts : [];
  const primaryContacts = Array.isArray(job.hiringContacts) ? job.hiringContacts : [];
  const contacts = (appliedContacts.length ? appliedContacts : primaryContacts).map((item) => String(item).trim()).filter(Boolean);

  if (!contacts.length) {
    throw new Error("No hiring contact emails are stored for this job.");
  }

  const profileBlock = profile ? formatProfileForPrompt(profile) : "";
  const resumeText = await loadResumeText(userId, job.resumeAssetId ? String(job.resumeAssetId) : null);
  const drafts = await Promise.all(
    contacts.slice(0, 5).map(async (contact) => {
      const draft = await generateHiringContactEmail({
        profileBlock,
        resumeText,
        listingText: String(job.listingText ?? ""),
        company: String(job.company ?? ""),
        roleTitle: String(job.sourceTitle ?? ""),
        contact,
        followUp: true,
        language: getAppLanguage()
      });

      return gmailComposeUrl({
        to: contact,
        subject: draft.subject,
        body: draft.body
      });
    })
  );

  await openUrlsInChromeWindow(drafts);

  return drafts.length;
}
