import { normalizeApplyUrl } from "../../../lib/apply-url";
import { extractJobListingUrlsFromHtml } from "../../../lib/services/job-listing-urls";
import {
  buildJobTeaserSearchSpec,
  hasJobTeaserBoard,
  type JobTeaserLocationMeta,
  type JobTeaserSearchSpec
} from "../../../lib/services/jobteaser";
import {
  buildWorkAtAStartupSearchSpec,
  hasWorkAtAStartupBoard,
  type WorkAtAStartupSearchSpec
} from "../../../lib/services/workatstartup";
import type { ParsedJobPage, SearchCandidate } from "../../../lib/types";
import { searchGoogleListingsWithOrganicFetcher, type OrganicSearchResult } from "../../../lib/services/organic-search";

import { enrichPreferenceInput, preferenceInputSchema, type PreferenceInput } from "./browser-preference";
import { fetchGoogleOrganicViaExtensionBatch } from "./extension-google-batch";
import { fetchGoogleJobsCandidatesViaExtension } from "./extension-google-jobs";
import { fetchJobTeaserCandidatesViaExtensionBatch } from "./extension-jobteaser-batch";
import { fetchPageHtmlViaExtension } from "./extension-page-html";
import { fetchWorkAtAStartupCandidatesViaExtensionBatch } from "./extension-workatstartup-batch";
import { formatProfileBlock } from "./format-profile-block";
import { generateFieldAnswersWithGemini } from "./gemini-field-answers";
import type { JobmateSqlite } from "./sqlite-client";

export type IngestProgressEvent =
  | { kind: "phase"; step: string; detail?: string }
  | { kind: "log"; line: string }
  | { kind: "failure"; message: string };

function shorten(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function ingestErrMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function nowInTimezoneParts(timezone: string, date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.get("hour") ?? "0");
  const minute = Number(map.get("minute") ?? "0");
  const year = map.get("year") ?? "1970";
  const month = map.get("month") ?? "01";
  const day = map.get("day") ?? "01";

  return {
    hour,
    minute,
    date: `${year}-${month}-${day}`
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

async function fetchListingHtml(url: string): Promise<{ html: string; finalUrl: string; ok: boolean }> {
  return fetchPageHtmlViaExtension(url);
}

async function fetchJobTeaserLocationMetaBrowser(location: string): Promise<JobTeaserLocationMeta> {
  const res = await fetch("/api/jobteaser-location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location })
  });

  const payload = (await res.json()) as JobTeaserLocationMeta & { error?: string };

  if (!res.ok) {
    throw new Error(payload.error ?? `jobteaser-location failed ${res.status}`);
  }

  return payload;
}

async function buildJobTeaserSearchSpecsBrowser(input: PreferenceInput): Promise<JobTeaserSearchSpec[]> {
  const specs: JobTeaserSearchSpec[] = [];

  for (const location of input.locations) {
    const meta = await fetchJobTeaserLocationMetaBrowser(location);
    specs.push(
      buildJobTeaserSearchSpec({
        title: input.title,
        keywordSeed: input.keywordSeed,
        location: meta
      })
    );
  }

  return specs;
}

function buildWorkAtAStartupSearchSpecsBrowser(input: PreferenceInput): WorkAtAStartupSearchSpec[] {
  return input.locations.map((location) =>
    buildWorkAtAStartupSearchSpec({
      title: input.title,
      keywordSeed: input.keywordSeed,
      locationQuery: location
    })
  );
}

function hasGoogleJobsBoard(domains: string[]): boolean {
  return domains.some((d) => String(d || "").toLowerCase().includes("google.com"));
}

function buildGoogleJobsUrl(query: string): string {
  const q = query.trim();
  if (!q) return "";
  const u = new URL("https://www.google.com/search");
  u.searchParams.set("q", q);
  u.searchParams.set("jbr", "sep:0");
  u.searchParams.set("udm", "8");
  return u.toString();
}

function mergeCandidateBucketsRoundRobin(buckets: SearchCandidate[][], limit: number): SearchCandidate[] {
  const deduped = new Map<string, SearchCandidate>();
  let round = 0;

  while (deduped.size < limit) {
    let addedThisRound = false;

    for (const bucket of buckets) {
      const candidate = bucket[round];

      if (!candidate || deduped.has(candidate.sourceUrl)) {
        continue;
      }

      deduped.set(candidate.sourceUrl, candidate);
      addedThisRound = true;

      if (deduped.size >= limit) {
        break;
      }
    }

    if (!addedThisRound) {
      break;
    }

    round += 1;
  }

  return [...deduped.values()].slice(0, limit);
}

async function parseJobFromHtml(
  html: string,
  sourceUrl: string,
  fallback: SearchCandidate,
  gemini: { apiKey: string | null; model: string }
): Promise<ParsedJobPage> {
  const res = await fetch("/api/parse-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      sourceUrl,
      fallback: {
        title: fallback.sourceTitle,
        company: fallback.company,
        location: fallback.location,
        snippet: fallback.snippet
      },
      geminiApiKey: gemini.apiKey ?? "",
      geminiModel: gemini.model
    })
  });

  const payload = (await res.json()) as ParsedJobPage & { error?: string };

  if (!res.ok) {
    throw new Error(payload.error ?? `parse-job failed ${res.status}`);
  }

  return payload;
}

function preferenceRowToInput(row: Record<string, unknown>): PreferenceInput {
  const parsed = preferenceInputSchema.safeParse({
    title: row.title,
    locations: JSON.parse(String(row.locations ?? "[]")),
    boardDomains: JSON.parse(String(row.board_domains ?? "[]")),
    keywordSeed: JSON.parse(String(row.keyword_seed ?? "[]")),
    searchAfterDays: Number(row.search_after_days ?? 14),
    contextBlock: String(row.context_block ?? ""),
    timezone: String(row.timezone ?? "America/Chicago"),
    scheduleHourLocal: Number(row.schedule_hour_local ?? 9)
  });

  if (!parsed.success) {
    throw new Error("Invalid preference row in database.");
  }

  return parsed.data;
}

export async function runBrowserIngestion(opts: {
  sqlite: JobmateSqlite;
  userId: string;
  geminiApiKey: string | null;
  geminiModel: string;
  webhookUrl?: string;
  perTargetLimit?: number;
  preferenceIds?: string[];
  onProgress?: (event: IngestProgressEvent) => void;
}): Promise<{ retrieved: number; createdJobs: number }> {
  const perTargetLimit = Math.max(1, Math.min(opts.perTargetLimit ?? 100, 100));
  const geminiParse = { apiKey: opts.geminiApiKey, model: opts.geminiModel };
  opts.onProgress?.({ kind: "phase", step: "Starting search pipeline" });
  const prefIds = Array.isArray(opts.preferenceIds) ? opts.preferenceIds.map(String).filter(Boolean) : [];
  const prefs = prefIds.length
    ? await opts.sqlite.all<Record<string, unknown>>(
        `SELECT * FROM preferences WHERE user_id = ? AND id IN (${prefIds.map(() => "?").join(", ")}) ORDER BY datetime(updated_at) DESC`,
        [opts.userId, ...prefIds]
      )
    : await opts.sqlite.all<Record<string, unknown>>(
        `SELECT * FROM preferences WHERE enabled != 0 AND user_id = ? ORDER BY datetime(updated_at) DESC`,
        [opts.userId]
      );

  const [profileRow] = await opts.sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [
    opts.userId
  ]);

  const profileResumeAssetId = profileRow?.resume_asset_id ? String(profileRow.resume_asset_id) : null;
  let profileResumePdf: Uint8Array | null = null;

  if (profileResumeAssetId) {
    const pdfRows = await opts.sqlite.all<{ file_blob: unknown }>(
      `SELECT file_blob FROM assets WHERE id = ? AND user_id = ? AND kind = 'resume_pdf'`,
      [profileResumeAssetId, opts.userId]
    );
    const fb = pdfRows[0]?.file_blob;

    if (fb instanceof Uint8Array && fb.byteLength > 0) {
      profileResumePdf = fb;
    }
  }

  let totalRetrieved = 0;
  let newJobsCount = 0;

  if (!prefs.length) {
    opts.onProgress?.({ kind: "phase", step: "Nothing to run", detail: prefIds.length ? "No selected targets" : "No enabled targets" });
    opts.onProgress?.({
      kind: "log",
      line: prefIds.length ? "Select at least one target, then run the pipeline again." : "Enable at least one target under Targets, then run the pipeline again."
    });
    return { retrieved: 0, createdJobs: 0 };
  }

  opts.onProgress?.({
    kind: "log",
    line: `Loaded ${prefs.length} enabled target${prefs.length === 1 ? "" : "s"}.`
  });

  for (let prefIndex = 0; prefIndex < prefs.length; prefIndex++) {
    const row = prefs[prefIndex];
    const prefId = String(row.id);
    const prefTitle = String(row.title ?? "");
    const input = preferenceRowToInput(row);
    const enriched = enrichPreferenceInput(input);
    const timezone = String(row.timezone ?? "America/Chicago");

    opts.onProgress?.({
      kind: "phase",
      step: `Target ${prefIndex + 1} of ${prefs.length}`,
      detail: prefTitle
    });
    opts.onProgress?.({
      kind: "log",
      line: `— Target: ${shorten(prefTitle, 120)}`
    });

    const localNow = nowInTimezoneParts(timezone);
    let jobTeaserCandidates: SearchCandidate[] = [];
    let workAtAStartupCandidates: SearchCandidate[] = [];
    const jobTeaserEnabled = hasJobTeaserBoard(enriched.boardDomains);
    const workAtAStartupEnabled = hasWorkAtAStartupBoard(enriched.boardDomains);

    if (jobTeaserEnabled) {
      opts.onProgress?.({
        kind: "phase",
        step: "JobTeaser search",
        detail: `${input.locations.length} location${input.locations.length === 1 ? "" : "s"}`
      });

      const specs = await buildJobTeaserSearchSpecsBrowser(input);
      const bySpec = await fetchJobTeaserCandidatesViaExtensionBatch(specs, perTargetLimit);
      const buckets = specs.map((spec) => bySpec.get(spec.id) ?? []);
      jobTeaserCandidates = mergeCandidateBucketsRoundRobin(buckets, perTargetLimit);

      opts.onProgress?.({
        kind: "log",
        line: `JobTeaser collected ${jobTeaserCandidates.length} listing URL${jobTeaserCandidates.length === 1 ? "" : "s"}.`
      });
    }

    if (workAtAStartupEnabled) {
      opts.onProgress?.({
        kind: "phase",
        step: "Work at a Startup search",
        detail: `${input.locations.length} location${input.locations.length === 1 ? "" : "s"}`
      });

      const specs = buildWorkAtAStartupSearchSpecsBrowser(input);
      const bySpec = await fetchWorkAtAStartupCandidatesViaExtensionBatch(specs, perTargetLimit);
      const buckets = specs.map((spec) => bySpec.get(spec.id) ?? []);
      workAtAStartupCandidates = mergeCandidateBucketsRoundRobin(buckets, perTargetLimit);

      opts.onProgress?.({
        kind: "log",
        line: `Work at a Startup collected ${workAtAStartupCandidates.length} listing URL${workAtAStartupCandidates.length === 1 ? "" : "s"}.`
      });
    }

    const trimmedForExt = enriched.searchQueries.map((q) => q.trim()).filter(Boolean);
    const uniqQueriesForExt = [...new Set(trimmedForExt)];

    const extensionOrganicByTrimmed = new Map<string, OrganicSearchResult[]>();

    if (uniqQueriesForExt.length) {
      opts.onProgress?.({
        kind: "phase",
        step: "Google search (Chrome extension)",
        detail: `${uniqQueriesForExt.length} quer${uniqQueriesForExt.length === 1 ? "y" : "ies"}`
      });

      for (let qi = 0; qi < uniqQueriesForExt.length; qi++) {
        const q = uniqQueriesForExt[qi];

        opts.onProgress?.({
          kind: "phase",
          step: "Google search (Chrome extension)",
          detail: `Query ${qi + 1} of ${uniqQueriesForExt.length}`
        });

        opts.onProgress?.({
          kind: "log",
          line: `Searching: ${shorten(q, 160)}`
        });

        const part = await fetchGoogleOrganicViaExtensionBatch([q], perTargetLimit);
        const rows = part.get(q) ?? [];
        extensionOrganicByTrimmed.set(q, rows);

        const hostSample = rows
          .slice(0, 5)
          .map((r) => {
            try {
              return new URL(r.link).hostname.replace(/^www\./i, "");
            } catch {
              return shorten(r.link, 36);
            }
          })
          .join(", ");

        opts.onProgress?.({
          kind: "log",
          line: `Collected ${rows.length} organic URLs${hostSample ? `: ${hostSample}${rows.length > 5 ? ", …" : ""}` : ""}`
        });
      }
    }

    const googleCandidates =
      enriched.searchQueries.length > 0
        ? await searchGoogleListingsWithOrganicFetcher(
            enriched.searchQueries,
            (q, lim) => {
              const rows = extensionOrganicByTrimmed.get(q.trim()) ?? [];
              return Promise.resolve(rows.slice(0, lim));
            },
            {
              limit: perTargetLimit,
              boardDomains: enriched.boardDomains
            }
          )
        : [];

    let googleJobsCandidates: SearchCandidate[] = [];
    if (hasGoogleJobsBoard(enriched.boardDomains) && uniqQueriesForExt.length) {
      opts.onProgress?.({
        kind: "phase",
        step: "Google Jobs search",
        detail: `${uniqQueriesForExt.length} quer${uniqQueriesForExt.length === 1 ? "y" : "ies"}`
      });
      for (let qi = 0; qi < uniqQueriesForExt.length; qi++) {
        const q = uniqQueriesForExt[qi];
        const url = buildGoogleJobsUrl(q);
        if (!url) continue;
        try {
          const rows = await fetchGoogleJobsCandidatesViaExtension(url, perTargetLimit);
          googleJobsCandidates.push(...rows);
        } catch (e) {
          opts.onProgress?.({ kind: "failure", message: `Google Jobs query failed: ${ingestErrMessage(e)}` });
        }
      }
      googleJobsCandidates = mergeCandidateBucketsRoundRobin([googleJobsCandidates], perTargetLimit);
      opts.onProgress?.({
        kind: "log",
        line: `Google Jobs: ${googleJobsCandidates.length} direct company listing URL${googleJobsCandidates.length === 1 ? "" : "s"}`
      });
    }

    const candidates = mergeCandidateBucketsRoundRobin(
      [jobTeaserCandidates, workAtAStartupCandidates, googleCandidates, googleJobsCandidates],
      perTargetLimit
    );

    const mergedSourceLabels = [
      jobTeaserEnabled ? "JobTeaser" : "",
      workAtAStartupEnabled ? "Work at a Startup" : "",
      enriched.searchQueries.length > 0 ? "Google (Chrome extension)" : "",
      googleJobsCandidates.length > 0 ? "Google Jobs" : ""
    ].filter(Boolean);

    totalRetrieved += candidates.length;
    opts.onProgress?.({
      kind: "phase",
      step: "Listings after filters",
      detail: `${candidates.length} URLs · ${prefTitle}`
    });
    opts.onProgress?.({
      kind: "log",
      line: `Merged ${candidates.length} candidate listing URL${candidates.length === 1 ? "" : "s"} (${mergedSourceLabels.join(" + ") || "none"}).`
    });

    const profileBlock = profileRow ? formatProfileBlock(profileRow) : "";
    const mergedContextBase = [profileBlock, enriched.contextBlock].filter((s) => s.trim().length > 0).join("\n\n---\n\n");
    const digestDate = localNow.date;
    const digestJobIds: string[] = [];
    let processed = 0;
    let rowInserted = 0;
    let rowRefreshed = 0;
    let rowSkippedApplied = 0;
    let rowFailed = 0;

    type QueueItem = { candidate: SearchCandidate; index: number };
    const queueItems: QueueItem[] = candidates.map((candidate, index) => ({ candidate, index }));

    opts.onProgress?.({
      kind: "phase",
      step: "Parse & insert listings",
      detail: candidates.length ? `${candidates.length} URLs · concurrency 5` : "No listings"
    });
    opts.onProgress?.({
      kind: "log",
      line: candidates.length
        ? `Parse queue · ${candidates.length} URLs · fetch HTML → parse → apply page (optional) → field answers → enrich → insert`
        : "Parse queue empty (nothing to insert)."
    });

    await runWithConcurrency(queueItems, 5, async ({ candidate, index }) => {
      const ord = `${index + 1}/${candidates.length}`;
      const urlShort = shorten(candidate.sourceUrl, 100);

      try {
        const existingRows = await opts.sqlite.all<{ id: string; status: string }>(
          `SELECT id, status FROM jobs WHERE user_id = ? AND source_url = ?`,
          [opts.userId, candidate.sourceUrl]
        );
        const existing = existingRows[0];

        if (existing) {
          opts.onProgress?.({
            kind: "phase",
            step: "Existing job row",
            detail: ord
          });
          opts.onProgress?.({
            kind: "log",
            line: `[${ord}] Duplicate URL · ${urlShort} · ${existing.status}`
          });

          if (existing.status !== "applied") {
            const now = new Date().toISOString();
            await opts.sqlite.run(
              `UPDATE jobs
               SET preference_id = ?, digest_date = ?, status = 'new', archived_at = NULL, updated_at = ?
               WHERE id = ? AND user_id = ?`,
              [prefId, digestDate, now, existing.id, opts.userId]
            );
            rowRefreshed += 1;
          } else {
            rowSkippedApplied += 1;
          }

          digestJobIds.push(existing.id);
          processed += 1;
          opts.onProgress?.({
            kind: "phase",
            step: "Parse & insert listings",
            detail: `${processed}/${candidates.length} processed`
          });
          opts.onProgress?.({
            kind: "log",
            line: `[${ord}] Linked to digest · ${existing.status === "applied" ? "already applied" : "refreshed as new"}`
          });
          return;
        }

        opts.onProgress?.({
          kind: "phase",
          step: "Fetch listing HTML",
          detail: ord
        });
        opts.onProgress?.({
          kind: "log",
          line: `[${ord}] GET · ${urlShort}`
        });

        const first = await fetchListingHtml(candidate.sourceUrl);

        if (!first.ok || !first.html.trim()) {
          throw new Error(
            `fetch-html unusable (ok=${Boolean(first.ok)} bytes=${first.html.length} final=${shorten(first.finalUrl, 80)})`
          );
        }

        const discoveredListings = extractJobListingUrlsFromHtml(first.html, first.finalUrl || candidate.sourceUrl);
        const listingSources =
          discoveredListings.length >= 2
            ? discoveredListings.map((sourceUrl) => ({ sourceUrl, prefetch: null as typeof first | null }))
            : [{ sourceUrl: candidate.sourceUrl, prefetch: first }];

        if (discoveredListings.length >= 2) {
          opts.onProgress?.({
            kind: "log",
            line: `[${ord}] List page · ${discoveredListings.length} job links`
          });
        }

        for (let li = 0; li < listingSources.length; li++) {
          const listingSource = listingSources[li];
          const subOrd = listingSources.length > 1 ? `${ord}.${li + 1}` : ord;
          const fetched =
            listingSource.prefetch ??
            (listingSource.sourceUrl === candidate.sourceUrl
              ? first
              : await fetchListingHtml(listingSource.sourceUrl));

          if (!fetched.ok || !fetched.html.trim()) {
            if (listingSources.length > 1) {
              opts.onProgress?.({
                kind: "log",
                line: `[${subOrd}] Skipped · fetch failed · ${shorten(listingSource.sourceUrl, 88)}`
              });
              continue;
            }
            throw new Error(
              `fetch-html unusable (ok=${Boolean(fetched.ok)} bytes=${fetched.html.length} final=${shorten(fetched.finalUrl, 80)})`
            );
          }

          const existingListRows = await opts.sqlite.all<{ id: string; status: string }>(
            `SELECT id, status FROM jobs WHERE user_id = ? AND source_url = ?`,
            [opts.userId, listingSource.sourceUrl]
          );
          const existingList = existingListRows[0];

          if (existingList) {
            if (listingSources.length === 1) {
              opts.onProgress?.({
                kind: "phase",
                step: "Existing job row",
                detail: subOrd
              });
              opts.onProgress?.({
                kind: "log",
                line: `[${subOrd}] Duplicate URL · ${shorten(listingSource.sourceUrl, 100)} · ${existingList.status}`
              });

              if (existingList.status !== "applied") {
                const now = new Date().toISOString();
                await opts.sqlite.run(
                  `UPDATE jobs
                   SET preference_id = ?, digest_date = ?, status = 'new', archived_at = NULL, updated_at = ?
                   WHERE id = ? AND user_id = ?`,
                  [prefId, digestDate, now, existingList.id, opts.userId]
                );
                rowRefreshed += 1;
              } else {
                rowSkippedApplied += 1;
              }

              digestJobIds.push(existingList.id);
              processed += 1;
              opts.onProgress?.({
                kind: "phase",
                step: "Parse & insert listings",
                detail: `${processed}/${candidates.length} processed`
              });
              opts.onProgress?.({
                kind: "log",
                line: `[${subOrd}] Linked to digest · ${existingList.status === "applied" ? "already applied" : "refreshed as new"}`
              });
              return;
            }

            continue;
          }

          opts.onProgress?.({
            kind: "phase",
            step: "Parse listing",
            detail: subOrd
          });

          const parsed = await parseJobFromHtml(
            fetched.html,
            listingSource.sourceUrl,
            { ...candidate, sourceUrl: listingSource.sourceUrl },
            geminiParse
          );

          let formFields = parsed.fields;
          const listingNorm = listingSource.sourceUrl.replace(/[#?].*$/, "");
          const applyNorm = normalizeApplyUrl(parsed.applyUrl);

          const dupApplyRows = await opts.sqlite.all<{ id: string; status: string }>(
            `SELECT id, status FROM jobs WHERE user_id = ? AND apply_url = ?`,
            [opts.userId, applyNorm]
          );

          if (dupApplyRows.length > 0) {
            const hasApplied = dupApplyRows.some((r) => r.status === "applied");

            if (hasApplied) {
              if (listingSources.length === 1) {
                rowSkippedApplied += 1;
                processed += 1;
              }
              continue;
            }

            const openDup = dupApplyRows.find((r) => r.status === "new" || r.status === "reviewed");

            if (openDup) {
              const now = new Date().toISOString();
              await opts.sqlite.run(
                `UPDATE jobs
                 SET preference_id = ?, digest_date = ?, status = 'new', archived_at = NULL, updated_at = ?
                 WHERE id = ? AND user_id = ?`,
                [prefId, digestDate, now, openDup.id, opts.userId]
              );
              digestJobIds.push(openDup.id);
              rowRefreshed += 1;
              processed += 1;
              if (listingSources.length === 1) {
                opts.onProgress?.({
                  kind: "log",
                  line: `[${subOrd}] Duplicate apply · refreshed open row · ${shorten(applyNorm, 88)}`
                });
              }
              continue;
            }
          }

          if (applyNorm.replace(/[#?].*$/, "") !== listingNorm) {
            try {
              const fh = await fetchListingHtml(parsed.applyUrl);
              if (fh.ok && fh.html.trim()) {
                const applyParsed = await parseJobFromHtml(fh.html, parsed.applyUrl, candidate, geminiParse);
                if (applyParsed.fields.length > 0) {
                  formFields = applyParsed.fields;
                }
              }
            } catch {
            }
          }

          const fieldAnswers = await generateFieldAnswersWithGemini({
            geminiApiKey: opts.geminiApiKey,
            geminiModel: opts.geminiModel,
            contextBlock: mergedContextBase,
            listingText: parsed.listingText,
            fields: formFields,
            resumePdfBytes: profileResumePdf
          });

          const enrichRes = await fetch("/api/job-enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              geminiApiKey: opts.geminiApiKey ?? "",
              geminiModel: opts.geminiModel,
              title: parsed.title,
              company: parsed.company,
              location: parsed.location,
              listingText: parsed.listingText,
              sourceUrl: listingSource.sourceUrl,
              parsedHomepage: parsed.companyHomepage ?? null,
              parsedLinkedinLinks: [],
              parsedHiringContacts: [],
              parsedSummary: parsed.summary,
              parsedCompensationRange: parsed.compensationRange ?? null,
              includeLeadSearch: false
            })
          });

          const enrichPayload = (await enrichRes.json()) as {
            compensationRange?: string | null;
            companyHomepage?: string | null;
            linkedinLinks?: string[];
            hiringContacts?: string[];
            summary?: string;
            error?: string;
          };

          if (!enrichRes.ok) {
            throw new Error(enrichPayload.error ?? `job-enrich failed ${enrichRes.status}`);
          }

          const compensationRangeFinal =
            enrichPayload.compensationRange ?? parsed.compensationRange ?? null;
          const companyHomepageFinal = enrichPayload.companyHomepage ?? parsed.companyHomepage ?? null;
          const summaryFinal = enrichPayload.summary ?? parsed.summary;
          const postedAtFinal = parsed.postedAt ?? null;
          const companyLogoUrlFinal = parsed.companyLogoUrl ?? null;

          const jobId = crypto.randomUUID();
          const now = new Date().toISOString();

          await opts.sqlite.run(
            `INSERT INTO jobs (
            id, user_id, preference_id, digest_date, source_url, source_host, source_title,
            company, location, compensation_range, company_homepage, linkedin_links, hiring_contacts,
            summary, listing_text, apply_url, fields,
            resume_asset_id, cover_letter_asset_id, status, discovered_at, posted_at, company_logo_url,
            applied_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              jobId,
              opts.userId,
              prefId,
              digestDate,
              listingSource.sourceUrl,
              candidate.sourceHost,
              parsed.title,
              parsed.company,
              parsed.location,
              compensationRangeFinal,
              companyHomepageFinal,
              JSON.stringify([]),
              JSON.stringify([]),
              summaryFinal,
              parsed.listingText,
              normalizeApplyUrl(parsed.applyUrl),
              JSON.stringify(fieldAnswers),
              profileResumeAssetId,
              null,
              "new",
              now,
              postedAtFinal,
              companyLogoUrlFinal,
              null,
              null,
              now,
              now
            ]
          );

          digestJobIds.push(jobId);
          rowInserted += 1;
          newJobsCount += 1;
          opts.onProgress?.({
            kind: "log",
            line: `[${subOrd}] Inserted · ${shorten(parsed.title, 70)} · ${shorten(listingSource.sourceUrl, 72)}`
          });
        }

        processed += 1;
        opts.onProgress?.({
          kind: "phase",
          step: "Parse & insert listings",
          detail: `${processed}/${candidates.length} processed`
        });
        return;
      } catch (err) {
        processed += 1;
        rowFailed += 1;
        opts.onProgress?.({
          kind: "phase",
          step: "Parse & insert listings",
          detail: `${processed}/${candidates.length} processed`
        });
        opts.onProgress?.({
          kind: "failure",
          message: `[${ord}] ${urlShort} · ${shorten(ingestErrMessage(err), 220)}`
        });
        opts.onProgress?.({
          kind: "log",
          line: `[${ord}] Failed · ${urlShort} · ${shorten(ingestErrMessage(err), 180)}`
        });
      }
    });

    opts.onProgress?.({
      kind: "log",
      line: `Parse summary · ${rowInserted} inserted · ${rowRefreshed} refreshed · ${rowSkippedApplied} already-applied · ${rowFailed} failed`
    });

    if (!digestJobIds.length) {
      opts.onProgress?.({
        kind: "log",
        line: `No digest rows for ${shorten(prefTitle, 80)} (nothing new or updated).`
      });
      continue;
    }

    opts.onProgress?.({
      kind: "phase",
      step: "Saving digest",
      detail: digestDate
    });

    const uniqIds = [...new Set(digestJobIds)];
    const digestRows = await opts.sqlite.all<{ id: string }>(
      `SELECT id FROM digests WHERE user_id = ? AND date = ?`,
      [opts.userId, digestDate]
    );
    const digestRow = digestRows[0];
    const digestId = digestRow?.id ?? crypto.randomUUID();
    const ts = new Date().toISOString();

    let idsStored = uniqIds;

    if (digestRow) {
      const idsRows = await opts.sqlite.all<{ job_ids: string }>(
        `SELECT job_ids FROM digests WHERE user_id = ? AND date = ?`,
        [opts.userId, digestDate]
      );
      const idsRow = idsRows[0];

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

      await opts.sqlite.run(`UPDATE digests SET job_ids = ?, updated_at = ? WHERE user_id = ? AND date = ?`, [
        JSON.stringify(idsStored),
        ts,
        opts.userId,
        digestDate
      ]);
    } else {
      await opts.sqlite.run(
        `INSERT INTO digests (id, user_id, date, job_ids, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [digestId, opts.userId, digestDate, JSON.stringify(idsStored), null, ts, ts]
      );
    }

    if (opts.webhookUrl?.trim()) {
      await fetch(opts.webhookUrl.trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `JobMate digest for ${digestDate}`,
          digestUrl: `/digests/${digestDate}`,
          date: digestDate,
          count: idsStored.length
        })
      });
    }

    await opts.sqlite.run(`UPDATE digests SET sent_at = ?, updated_at = ? WHERE user_id = ? AND date = ?`, [
      ts,
      ts,
      opts.userId,
      digestDate
    ]);

    opts.onProgress?.({
      kind: "log",
      line: `Digest ${digestDate} stored (${uniqIds.length} job reference${uniqIds.length === 1 ? "" : "s"}).`
    });
  }

  opts.onProgress?.({ kind: "phase", step: "Finished" });
  return { retrieved: totalRetrieved, createdJobs: newJobsCount };
}
