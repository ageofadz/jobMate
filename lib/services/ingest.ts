import { randomUUID } from "node:crypto";

import { normalizeApplyUrl } from "@/lib/apply-url";
import { reportError } from "@/cli/report-error";
import { ensureIndexes, getSqlite } from "@/lib/db";
import { formatProfileForPrompt, getUserProfile, loadResumePdfPayload } from "@/lib/data";
import { writeUploadedFile } from "@/lib/files";
import { buildGeneratedKeywords, buildSearchQueries } from "@/lib/services/keywords";
import { generateFieldAnswers, generateJobDetailsSummary } from "@/lib/services/llm";
import { buildCoverLetterDocx } from "@/lib/services/docx";
import { enrichJobLeadMetadata } from "@/lib/services/job-enrichment";
import { parseJobPage } from "@/lib/services/job-page";
import { sendDigestNotification } from "@/lib/services/notifications";
import type { JobRecord, PreferenceRecord } from "@/lib/types";
import { nowInTimezoneParts } from "@/lib/utils";

export type IngestionProgress =
  | { stage: "target"; targetTitle: string; targetIndex: number; targetTotal: number }
  | {
      stage: "search_queries";
      targetTitle: string;
      targetIndex: number;
      targetTotal: number;
      completed: number;
      total: number;
    }
  | { stage: "retrieved"; targetTitle: string; targetIndex: number; targetTotal: number; retrieved: number; limit: number }
  | { stage: "processing"; targetTitle: string; targetIndex: number; targetTotal: number; processed: number; retrieved: number; created: number }
  | { stage: "inserted"; targetTitle: string; targetIndex: number; targetTotal: number; jobId: string; created: number; processed: number; retrieved: number }
  | { stage: "done"; created: number; retrieved: number };

export async function runIngestion(options: {
  userId?: string;
  perTargetLimit?: number;
  onProgress?: (progress: IngestionProgress) => void;
} = {}) {
  await ensureIndexes();
  const db = getSqlite();
  const prefs = (options.userId
    ? db
        .prepare(`SELECT * FROM preferences WHERE enabled != 0 AND user_id = ? ORDER BY updated_at DESC`)
        .all(options.userId)
    : db.prepare(`SELECT * FROM preferences WHERE enabled != 0 ORDER BY updated_at DESC`).all()) as PreferenceSqlRow[];
  const createdJobs: JobRecord[] = [];
  let totalRetrieved = 0;
  const perTargetLimit = Math.max(1, Math.min(options.perTargetLimit ?? 100, 100));

  if (prefs.length > 0) {
    throw new Error(
      "CLI job search requires the JobMate web app and Chrome extension. Run search from the web dashboard with the extension installed."
    );
  }

  for (let prefIndex = 0; prefIndex < prefs.length; prefIndex++) {
    const row = prefs[prefIndex];
    const preference = preferenceRowToRecord(row);
    options.onProgress?.({
      stage: "target",
      targetTitle: preference.title,
      targetIndex: prefIndex + 1,
      targetTotal: prefs.length
    });

    const localNow = nowInTimezoneParts(preference.timezone);

    const searchQueries = buildSearchQueries({
      title: preference.title,
      locations: preference.locations,
      boardDomains: preference.boardDomains,
      keywordSeed: preference.keywordSeed,
      searchAfterDays: preference.searchAfterDays,
      contextBlock: preference.contextBlock,
      timezone: preference.timezone,
      scheduleHourLocal: preference.scheduleHourLocal
    });

    void searchQueries;
    const candidates: { sourceUrl: string }[] = [];
    totalRetrieved += candidates.length;
    options.onProgress?.({
      stage: "retrieved",
      targetTitle: preference.title,
      targetIndex: prefIndex + 1,
      targetTotal: prefs.length,
      retrieved: candidates.length,
      limit: perTargetLimit
    });
    const profile = getUserProfile(preference.userId);
    const profileResumeId = profile?.resumeAssetId ?? null;
    const resumePdf = loadResumePdfPayload(preference.userId, profileResumeId)?.buffer ?? null;
    const profileBlock = profile ? formatProfileForPrompt(profile) : "";
    const mergedContextBase = [profileBlock, preference.contextBlock].filter((s) => s.trim().length > 0).join("\n\n---\n\n");
    const digestDate = localNow.date;
    const digestJobIds: string[] = [];
    let processed = 0;
    let createdForTarget = 0;

    await runWithConcurrency(candidates, 5, async (candidate) => {
      try {
      const existing = db
        .prepare(`SELECT id, status FROM jobs WHERE user_id = ? AND source_url = ?`)
        .get(preference.userId, candidate.sourceUrl) as { id: string; status: string } | undefined;

      if (existing) {
        if (existing.status !== "applied") {
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE jobs
             SET preference_id = ?, digest_date = ?, status = 'new', archived_at = NULL, updated_at = ?
             WHERE id = ? AND user_id = ?`
          ).run(preference._id as string, digestDate, now, existing.id, preference.userId);
          createdForTarget += 1;
        }

        digestJobIds.push(existing.id);
        processed += 1;
        options.onProgress?.({
          stage: "processing",
          targetTitle: preference.title,
          targetIndex: prefIndex + 1,
          targetTotal: prefs.length,
          processed,
          retrieved: candidates.length,
          created: createdForTarget
        });
        return;
      }

      const parsed = await parseJobPage(candidate.sourceUrl, {
        title: candidate.sourceTitle,
        company: candidate.company,
        location: candidate.location,
        snippet: candidate.snippet
      });

      const applyNorm = normalizeApplyUrl(parsed.applyUrl);

      const dupApplyRows = db
        .prepare(`SELECT id, status FROM jobs WHERE user_id = ? AND apply_url = ?`)
        .all(preference.userId, applyNorm) as { id: string; status: string }[];

      if (dupApplyRows.length > 0) {
        const hasApplied = dupApplyRows.some((r) => r.status === "applied");

        if (hasApplied) {
          processed += 1;
          options.onProgress?.({
            stage: "processing",
            targetTitle: preference.title,
            targetIndex: prefIndex + 1,
            targetTotal: prefs.length,
            processed,
            retrieved: candidates.length,
            created: createdForTarget
          });
          return;
        }

        const openDup = dupApplyRows.find((r) => r.status === "new" || r.status === "reviewed");

        if (openDup) {
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE jobs
             SET preference_id = ?, digest_date = ?, status = 'new', archived_at = NULL, updated_at = ?
             WHERE id = ? AND user_id = ?`
          ).run(preference._id as string, digestDate, now, openDup.id, preference.userId);
          digestJobIds.push(openDup.id);
          processed += 1;
          createdForTarget += 1;
          options.onProgress?.({
            stage: "processing",
            targetTitle: preference.title,
            targetIndex: prefIndex + 1,
            targetTotal: prefs.length,
            processed,
            retrieved: candidates.length,
            created: createdForTarget
          });
          return;
        }
      }

      let formFields = parsed.fields;
      const listingNorm = candidate.sourceUrl.replace(/[#?].*$/, "");
      const applyNormStrip = applyNorm.replace(/[#?].*$/, "");

      if (applyNormStrip !== listingNorm) {
        try {
          const applyParsed = await parseJobPage(parsed.applyUrl, {
            title: candidate.sourceTitle,
            company: candidate.company,
            location: candidate.location,
            snippet: candidate.snippet
          });

          if (applyParsed.fields.length > 0) {
            formFields = applyParsed.fields;
          }
        } catch {
        }
      }

      const fieldAnswers = await generateFieldAnswers({
        contextBlock: mergedContextBase,
        listingText: parsed.listingText,
        fields: formFields,
        resumePdf
      });

      const leadMetadata = await enrichJobLeadMetadata({
        company: parsed.company,
        listingText: parsed.listingText,
        sourceUrl: candidate.sourceUrl,
        parsedHomepage: parsed.companyHomepage ?? null,
        parsedLinkedinLinks: parsed.linkedinLinks ?? []
      });
      const detailSummary = await generateJobDetailsSummary({
        title: parsed.title,
        company: parsed.company,
        location: parsed.location,
        listingText: parsed.listingText,
        fallbackSummary: parsed.summary
      });

      let coverLetterAssetId: string | null = null;

      const coverLetterBody = fieldAnswers.find((field) => /cover/i.test(field.label))?.answer;

      if (coverLetterBody) {
        const letterName = profile?.fullName?.trim() ?? "";
        const docxBuffer = await buildCoverLetterDocx({
          candidateName: letterName,
          company: parsed.company,
          roleTitle: parsed.title,
          body: coverLetterBody
        });

        const filename = `${parsed.company}-${parsed.title}.docx`;
        const { relativePath } = writeUploadedFile(docxBuffer, filename);
        const assetId = randomUUID();
        const now = new Date().toISOString();

        db.prepare(
          `INSERT INTO assets (id, user_id, kind, filename, mime_type, byte_length, storage_path, extracted_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          assetId,
          preference.userId,
          "cover_letter_docx",
          filename,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          docxBuffer.byteLength,
          relativePath,
          null,
          now
        );

        coverLetterAssetId = assetId;
      }

      const jobId = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO jobs (
          id, user_id, preference_id, digest_date, source_url, source_host, source_title,
          company, location, compensation_range, company_homepage, linkedin_links, hiring_contacts,
          summary, listing_text, apply_url, fields,
          resume_asset_id, cover_letter_asset_id, status, discovered_at, applied_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        preference.userId,
        preference._id as string,
        digestDate,
        candidate.sourceUrl,
        candidate.sourceHost,
        parsed.title,
        parsed.company,
        parsed.location,
        leadMetadata.compensationRange ?? parsed.compensationRange ?? null,
        leadMetadata.companyHomepage ?? parsed.companyHomepage ?? null,
        JSON.stringify(leadMetadata.linkedinLinks.length ? leadMetadata.linkedinLinks : parsed.linkedinLinks ?? []),
        JSON.stringify(leadMetadata.hiringContacts.length ? leadMetadata.hiringContacts : parsed.hiringContacts ?? []),
        detailSummary,
        parsed.listingText,
        applyNorm,
        JSON.stringify(fieldAnswers),
        profileResumeId,
        coverLetterAssetId,
        "new",
        now,
        null,
        null,
        now,
        now
      );

      digestJobIds.push(jobId);

      createdJobs.push({
        _id: jobId,
        userId: preference.userId,
        preferenceId: preference._id as string,
        digestDate,
        sourceUrl: candidate.sourceUrl,
        sourceHost: candidate.sourceHost,
        sourceTitle: parsed.title,
        company: parsed.company,
        location: parsed.location,
        compensationRange: leadMetadata.compensationRange ?? parsed.compensationRange ?? null,
        companyHomepage: leadMetadata.companyHomepage ?? parsed.companyHomepage ?? null,
        linkedinLinks: leadMetadata.linkedinLinks.length ? leadMetadata.linkedinLinks : parsed.linkedinLinks ?? [],
        hiringContacts: leadMetadata.hiringContacts.length ? leadMetadata.hiringContacts : parsed.hiringContacts ?? [],
        summary: detailSummary,
        listingText: parsed.listingText,
        applyUrl: applyNorm,
        fields: fieldAnswers,
        resumeAssetId: profileResumeId,
        coverLetterAssetId,
        status: "new",
        discoveredAt: new Date(now),
        appliedAt: null,
        archivedAt: null,
        createdAt: new Date(now),
        updatedAt: new Date(now)
      });
      processed += 1;
      createdForTarget += 1;
      options.onProgress?.({
        stage: "inserted",
        targetTitle: preference.title,
        targetIndex: prefIndex + 1,
        targetTotal: prefs.length,
        jobId,
        created: createdForTarget,
        processed,
        retrieved: candidates.length
      });
      } catch (err) {
        reportError(`Ingest skipped: ${candidate.sourceUrl}`, err);
        processed += 1;
        options.onProgress?.({
          stage: "processing",
          targetTitle: preference.title,
          targetIndex: prefIndex + 1,
          targetTotal: prefs.length,
          processed,
          retrieved: candidates.length,
          created: createdForTarget
        });
      }
    });

    if (!digestJobIds.length) {
      continue;
    }

    const uniqIds = [...new Set(digestJobIds)];
    const digestRow = db.prepare(`SELECT id FROM digests WHERE user_id = ? AND date = ?`).get(preference.userId, digestDate) as
      | { id: string }
      | undefined;

    const digestId = digestRow?.id ?? randomUUID();
    const ts = new Date().toISOString();

    let idsStored = uniqIds;

    if (digestRow) {
      const idsRow = db.prepare(`SELECT job_ids FROM digests WHERE user_id = ? AND date = ?`).get(preference.userId, digestDate) as
        | { job_ids: string }
        | undefined;

      let prevIds: string[] = [];

      if (idsRow?.job_ids) {
        try {
          const parsed = JSON.parse(idsRow.job_ids) as unknown;
          prevIds = Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          prevIds = [];
        }
      }

      idsStored = [...new Set([...prevIds, ...uniqIds])];

      db.prepare(`UPDATE digests SET job_ids = ?, updated_at = ? WHERE user_id = ? AND date = ?`).run(
        JSON.stringify(idsStored),
        ts,
        preference.userId,
        digestDate
      );
    } else {
      db.prepare(
        `INSERT INTO digests (id, user_id, date, job_ids, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(digestId, preference.userId, digestDate, JSON.stringify(idsStored), null, ts, ts);
    }

    await sendDigestNotification({
      title: `JobMate digest for ${digestDate}`,
      digestUrl: `/digests/${digestDate}`,
      date: digestDate,
      count: idsStored.length
    });

    db.prepare(`UPDATE digests SET sent_at = ?, updated_at = ? WHERE user_id = ? AND date = ?`).run(
      ts,
      ts,
      preference.userId,
      digestDate
    );
  }

  return {
    createdJobs: createdJobs.length,
    retrieved: totalRetrieved
  };
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });

  await Promise.all(workers);
}

type PreferenceSqlRow = {
  id: string;
  user_id: string;
  title: string;
  enabled: number;
  locations: string;
  board_domains: string;
  keyword_seed: string;
  generated_keywords: string;
  search_queries: string;
  search_after_days: number;
  context_block: string;
  timezone: string;
  schedule_hour_local: number;
  resume_asset_id: string | null;
  created_at: string;
  updated_at: string;
};

function preferenceRowToRecord(row: PreferenceSqlRow): PreferenceRecord & { _id: string } {
  return {
    _id: row.id,
    userId: row.user_id,
    title: row.title,
    enabled: row.enabled !== 0,
    locations: JSON.parse(row.locations),
    boardDomains: JSON.parse(row.board_domains),
    keywordSeed: JSON.parse(row.keyword_seed),
    generatedKeywords: JSON.parse(row.generated_keywords),
    searchQueries: JSON.parse(row.search_queries),
    searchAfterDays: row.search_after_days ?? 14,
    contextBlock: row.context_block,
    timezone: row.timezone,
    scheduleHourLocal: row.schedule_hour_local,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}
