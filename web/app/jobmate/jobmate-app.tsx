import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { normalizeApplyUrl } from "@/lib/apply-url";

import { openBackgroundTabViaExtension } from "./extension-open-tab";
import { runBrowserIngestion } from "./browser-ingest";
import { classifyJobEmailStatus } from "./gemini-field-answers";
import {
  SETTING_APPLY_EMAIL,
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL,
  SETTING_INITIAL_SETUP_COMPLETE,
  SETTING_LANGUAGE,
  SETTING_NOTIFICATION_WEBHOOK_URL,
  SETTING_SERPAPI_API_KEY
} from "./kv-keys";
import { PreferenceEditorModal } from "./preference-editor";
import { insertResumePdfAsset, setUserResumeAsset } from "./browser-resume-asset";
import type { JobmateSqlite } from "./sqlite-client";
import { BrowserProfileWizard, BrowserSetupWizard } from "./startup-wizard";
import { useJobmateSqlite } from "./sqlite-context";
import { formatProfileBlock } from "./format-profile-block";
import { ResultsPanel, type ResultJobRow } from "./results-panel";

type PageId = "home" | "targets" | "results" | "statuses" | "metrics" | "config";

const NAV: { id: PageId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "targets", label: "Targets" },
  { id: "results", label: "Results" },
  { id: "statuses", label: "Statuses" },
  { id: "metrics", label: "Metrics" },
  { id: "config", label: "Config" }
];

function parseStoredJsonStrings(raw: string | null | undefined): string[] {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

type BucketJobRow = {
  id: string;
  company: string;
  source_title: string;
  status: string;
  discovered_at: string;
  applied_at: string | null;
  archived_at: string | null;
  apply_url: string;
  source_url: string;
  summary: string;
  listing_text: string;
  compensation_range: string | null;
  location: string;
  company_homepage: string | null;
  linkedin_links: string | null;
  hiring_contacts: string | null;
  applied_application_url: string | null;
  applied_at_linkedin_links: string | null;
  applied_at_hiring_contacts: string | null;
  email_status: string | null;
};

export function JobmateApp() {
  const { sqlite, ready, error } = useJobmateSqlite();
  const [page, setPage] = useState<PageId>("home");
  const [userBootstrap, setUserBootstrap] = useState<"pending" | "done">("pending");
  const [userId, setUserId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [prefCount, setPrefCount] = useState<number>(0);
  const [statusCounts, setStatusCounts] = useState<{ status: string; n: number }[]>([]);

  const [prefs, setPrefs] = useState<{ id: string; title: string; enabled: number; updated_at: string }[]>([]);

  const [resultsPrefFilter, setResultsPrefFilter] = useState<string | "all">("all");
  const [resultJobs, setResultJobs] = useState<ResultJobRow[]>([]);

  const [statusBucket, setStatusBucket] = useState<"archived" | "applied">("archived");
  const [bucketJobs, setBucketJobs] = useState<BucketJobRow[]>([]);

  const [applySession, setApplySession] = useState<{
    jobId: string;
    company: string;
    sourceTitle: string;
    applyUrl: string;
    status: string;
    needsAttention: boolean;
    attentionMessage: string;
    attentionInstruction: string;
    kind: string;
  } | null>(null);

  const [emailSyncBusy, setEmailSyncBusy] = useState(false);

  const [metricRows, setMetricRows] = useState<{ day: string; retrieved: number; applied: number }[]>([]);

  const [dataEpoch, setDataEpoch] = useState(0);
  const [ingestRunning, setIngestRunning] = useState(false);
  const ingestRunningRef = useRef(false);
  const ingestPhaseRef = useRef<{ step: string; detail: string }>({ step: "", detail: "" });
  const [prefModal, setPrefModal] = useState<null | { mode: "add" | "edit"; row: Record<string, unknown> | null }>(
    null
  );
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const bumpData = useCallback(() => {
    setDataEpoch((x) => x + 1);
  }, []);

  useEffect(() => {
    function onExtensionMessage(ev: MessageEvent) {
      const data = ev.data as {
        source?: string;
        type?: string;
        message?: string;
        instruction?: string;
        applyUrl?: string;
        kind?: string;
      };
      if (!data || data.source !== "jobmate-extension") {
        return;
      }
      if (data.type === "JOBMATE_APPLY_STARTED") {
        setApplySession((prev) =>
          prev ? { ...prev, status: "Applying…" } : prev
        );
        return;
      }
      if (data.type !== "JOBMATE_APPLY_ATTENTION") {
        return;
      }
      setApplySession((prev) =>
        prev
          ? {
              ...prev,
              status: data.kind === "confirm" ? "Review ready" : "Needs attention",
              needsAttention: true,
              attentionMessage: data.message ?? "",
              attentionInstruction: data.instruction ?? "",
              kind: data.kind ?? "stuck"
            }
          : prev
      );
    }
    window.addEventListener("message", onExtensionMessage);
    return () => window.removeEventListener("message", onExtensionMessage);
  }, []);

  const [setupGateResolved, setSetupGateResolved] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);

  useEffect(() => {
    const failRefresh = (action: string) => {
      throw new Error(`JobMate blocked forbidden browser refresh/navigation attempt via ${action}.`);
    };

    const locationObject = window.location as Location & {
      reload?: () => void;
      assign?: (url: string | URL) => void;
      replace?: (url: string | URL) => void;
      __jobmateReloadBlocked?: boolean;
    };

    if (!locationObject.__jobmateReloadBlocked) {
      try {
        locationObject.reload = () => failRefresh("location.reload");
      } catch {
      }

      try {
        locationObject.assign = (_url: string | URL) => failRefresh("location.assign");
      } catch {
      }

      try {
        locationObject.replace = (_url: string | URL) => failRefresh("location.replace");
      } catch {
      }

      locationObject.__jobmateReloadBlocked = true;
    }

    function onKeyDown(ev: KeyboardEvent) {
      const key = ev.key.toLowerCase();
      const isRefreshShortcut =
        key === "f5" || ((ev.metaKey || ev.ctrlKey) && key === "r");

      if (!isRefreshShortcut) {
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();
      toast.error("JobMate blocked browser refresh.");
    }

    function onBeforeUnload(ev: BeforeUnloadEvent) {
      ev.preventDefault();
      ev.returnValue = "";
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  useEffect(() => {
    if (!sqlite || !ready) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const rows = await sqlite.all<{ id: string }>(
          "SELECT id FROM users ORDER BY datetime(created_at) ASC LIMIT 1"
        );

        if (cancelled) {
          return;
        }

        setUserId(rows[0]?.id ?? null);
        setUserBootstrap("done");
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : String(e));
          setUserId(null);
          setUserBootstrap("done");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, ready]);

  useEffect(() => {
    if (!sqlite || userId === null) {
      setSetupGateResolved(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      const rows = await sqlite.all<{ value: string }>(
        "SELECT value FROM kv_settings WHERE key = ?",
        [SETTING_INITIAL_SETUP_COMPLETE]
      );

      if (cancelled) {
        return;
      }

      setSetupComplete(rows[0]?.value === "1");
      setSetupGateResolved(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId]);

  const loadPage = useCallback(async () => {
    if (!sqlite || userId === null) {
      return;
    }

    const hideMainLoading = ingestRunningRef.current;

    if (!hideMainLoading) {
      setBusy(true);
    }

    setFetchError(null);

    try {
      if (page === "home" || page === "config") {
        const [u] = await sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId]);
        const [{ c }] = await sqlite.all<{ c: number }>(
          "SELECT COUNT(*) as c FROM preferences WHERE user_id = ?",
          [userId]
        );
        const sc = await sqlite.all<{ status: string; n: number }>(
          "SELECT status, COUNT(*) as n FROM jobs WHERE user_id = ? GROUP BY status ORDER BY status",
          [userId]
        );
        setProfile(u ?? null);
        setPrefCount(Number(c));
        setStatusCounts(sc);
      } else if (page === "targets") {
        const rows = await sqlite.all<{ id: string; title: string; enabled: number; updated_at: string }>(
          "SELECT id, title, enabled, updated_at FROM preferences WHERE user_id = ? ORDER BY datetime(updated_at) DESC",
          [userId]
        );
        setPrefs(rows);
      } else if (page === "results") {
        const prow = await sqlite.all<{ id: string; title: string; enabled: number; updated_at: string }>(
          "SELECT id, title, enabled, updated_at FROM preferences WHERE user_id = ? ORDER BY datetime(updated_at) DESC",
          [userId]
        );
        setPrefs(prow);
        const jrows = await sqlite.all<ResultJobRow>(
          `SELECT id, preference_id, company, source_title, status, discovered_at, posted_at, company_logo_url, apply_url,
            source_url, summary, listing_text, compensation_range, location, company_homepage,
            linkedin_links, hiring_contacts
           FROM jobs WHERE user_id = ? AND status IN ('new', 'reviewed') ORDER BY datetime(discovered_at) DESC`,
          [userId]
        );
        setResultJobs(jrows);
      } else if (page === "statuses") {
        const statuses =
          statusBucket === "archived"
            ? (["archived", "dismissed"] as const)
            : (["applied"] as const);
        const placeholders = statuses.map(() => "?").join(", ");
        const jrows = await sqlite.all<BucketJobRow>(
          `SELECT id, company, source_title, status, discovered_at, applied_at, archived_at, apply_url,
            source_url, summary, listing_text, compensation_range, location, company_homepage,
            linkedin_links, hiring_contacts, applied_application_url, applied_at_linkedin_links, applied_at_hiring_contacts, email_status
           FROM jobs WHERE user_id = ? AND status IN (${placeholders}) ORDER BY datetime(COALESCE(applied_at, archived_at, discovered_at)) DESC`,
          [userId, ...statuses]
        );
        setBucketJobs(jrows);
      } else if (page === "metrics") {
        const mrows = await sqlite.all<{ day: string; retrieved: number; applied: number }>(
          `WITH dates AS (
            SELECT substr(discovered_at, 1, 10) AS day FROM jobs WHERE user_id = ?
            UNION
            SELECT substr(applied_at, 1, 10) AS day FROM jobs WHERE user_id = ? AND applied_at IS NOT NULL
          )
          SELECT
            day,
            (SELECT COUNT(*) FROM jobs j WHERE j.user_id = ? AND substr(j.discovered_at, 1, 10) = dates.day) AS retrieved,
            (SELECT COUNT(*) FROM jobs j WHERE j.user_id = ? AND j.applied_at IS NOT NULL AND substr(j.applied_at, 1, 10) = dates.day) AS applied
          FROM dates
          ORDER BY day DESC
          LIMIT ?`,
          [userId, userId, userId, userId, 14]
        );
        setMetricRows(mrows);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!hideMainLoading) {
        setBusy(false);
      }
    }
  }, [sqlite, userId, page, statusBucket, dataEpoch]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const openJobsCount = useMemo(() => {
    let n = 0;
    for (const r of statusCounts) {
      if (r.status === "new" || r.status === "reviewed") {
        n += r.n;
      }
    }
    return n;
  }, [statusCounts]);

  const runSearchPipeline = useCallback(async () => {
    if (!sqlite || userId === null) {
      return;
    }

    if (ingestRunningRef.current) {
      toast.warning("Search pipeline already running");
      return;
    }

    const serpRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
      SETTING_SERPAPI_API_KEY
    ]);
    const gemRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
      SETTING_GEMINI_API_KEY
    ]);
    const modRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
      SETTING_GEMINI_MODEL
    ]);
    const hookRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
      SETTING_NOTIFICATION_WEBHOOK_URL
    ]);

    ingestPhaseRef.current = { step: "", detail: "" };
    ingestRunningRef.current = true;
    setIngestRunning(true);
    toast.loading("Search pipeline", { id: "jobmate-ingest", description: "Starting…" });

    try {
      const result = await runBrowserIngestion({
        sqlite,
        userId,
        serpApiKey: serpRows[0]?.value ?? "",
        geminiApiKey: gemRows[0]?.value?.trim() ? gemRows[0].value : null,
        geminiModel: modRows[0]?.value?.trim() || "gemini-3.1-flash-lite",
        webhookUrl: hookRows[0]?.value?.trim() ?? "",
        perTargetLimit: 100,
        onProgress: (ev) => {
          if (ev.kind === "phase") {
            ingestPhaseRef.current = {
              step: ev.step,
              detail: ev.detail ?? ""
            };
            const label =
              ev.detail !== undefined && ev.detail !== ""
                ? `${ev.step} · ${ev.detail}`
                : ev.step;
            toast.loading(label, { id: "jobmate-ingest" });
            return;
          }
          if (ev.kind === "failure") {
            toast.error(ev.message, { duration: 12000 });
            return;
          }
          const { step, detail } = ingestPhaseRef.current;
          const line =
            ev.line.length > 160 ? `${ev.line.slice(0, 157)}…` : ev.line;
          if (detail !== "") {
            toast.loading(`${step} · ${detail}`, {
              id: "jobmate-ingest",
              description: line
            });
          } else if (step !== "") {
            toast.loading(step, {
              id: "jobmate-ingest",
              description: line
            });
          } else {
            toast.loading(line, { id: "jobmate-ingest" });
          }
        }
      });
      toast.success(
        `Done. Retrieved ${result.retrieved}; added ${result.createdJobs} new job row(s).`,
        { id: "jobmate-ingest", duration: 8000 }
      );
      bumpData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg, { id: "jobmate-ingest", duration: 12000 });
    } finally {
      ingestRunningRef.current = false;
      setIngestRunning(false);
    }
  }, [sqlite, userId, bumpData]);

  async function loadPreferenceRow(prefId: string) {
    if (!sqlite || userId === null) {
      return null;
    }
    const rows = await sqlite.all<Record<string, unknown>>(`SELECT * FROM preferences WHERE id = ? AND user_id = ?`, [
      prefId,
      userId
    ]);
    return rows[0] ?? null;
  }

  async function togglePreferenceEnabled(prefId: string, enabled: boolean) {
    if (!sqlite || userId === null) {
      return;
    }
    const now = new Date().toISOString();
    await sqlite.run(`UPDATE preferences SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
      enabled ? 1 : 0,
      now,
      prefId,
      userId
    ]);
    bumpData();
  }

  async function deletePreference(prefId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    await sqlite.run(`DELETE FROM preferences WHERE id = ? AND user_id = ?`, [prefId, userId]);
    bumpData();
  }

  async function clearJobHistory() {
    if (!sqlite || userId === null) {
      return;
    }
    await sqlite.run(`DELETE FROM jobs WHERE user_id = ? AND status IN ('applied', 'archived', 'dismissed')`, [userId]);
    setConfirmClearHistory(false);
    bumpData();
  }

  async function archiveJobRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    const now = new Date().toISOString();
    await sqlite.run(`UPDATE jobs SET status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
      "archived",
      now,
      now,
      jobId,
      userId
    ]);
    bumpData();
  }

  async function markAppliedRow(jobId: string, applyUrl: string) {
    if (!sqlite || userId === null) {
      return;
    }
    const rows = await sqlite.all<{ hiring_contacts: string | null; linkedin_links: string | null }>(
      `SELECT hiring_contacts, linkedin_links FROM jobs WHERE id = ? AND user_id = ?`,
      [jobId, userId]
    );
    const row = rows[0];
    const now = new Date().toISOString();
    const contacts = row?.hiring_contacts ?? "[]";
    const links = row?.linkedin_links ?? "[]";
    await sqlite.run(
      `UPDATE jobs SET status = ?, applied_at = ?, applied_application_url = ?, applied_at_hiring_contacts = ?, applied_at_linkedin_links = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ["applied", now, applyUrl, contacts, links, now, jobId, userId]
    );
    bumpData();
  }

  async function unarchiveRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    const now = new Date().toISOString();
    await sqlite.run(
      `UPDATE jobs SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('archived', 'dismissed')`,
      ["new", now, jobId, userId]
    );
    bumpData();
  }

  async function unapplyRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    const now = new Date().toISOString();
    await sqlite.run(
      `UPDATE jobs SET status = ?, applied_at = NULL, applied_application_url = NULL, applied_at_hiring_contacts = '[]', applied_at_linkedin_links = '[]', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'applied'`,
      ["new", now, jobId, userId]
    );
    bumpData();
  }

  const openChromeApplyForJob = useCallback(
    async (jobId: string) => {
      if (!sqlite || userId === null) {
        return;
      }

      if (applySession) {
        return;
      }

      const gemRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_API_KEY
      ]);
      const modRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_MODEL
      ]);
      const geminiApiKey = gemRows[0]?.value?.trim() ?? "";
      const geminiModel = modRows[0]?.value?.trim() || "gemini-3.1-flash-lite";

      if (!geminiApiKey) {
        window.alert("Add a Gemini API key in Config to use Chrome fill.");
        return;
      }

      const jobRows = await sqlite.all<{
        apply_url: string;
        company: string;
        source_title: string;
        listing_text: string | null;
        company_homepage: string | null;
        linkedin_links: string | null;
        hiring_contacts: string | null;
      }>(
        `SELECT apply_url, company, source_title, listing_text, company_homepage, linkedin_links, hiring_contacts FROM jobs WHERE id = ? AND user_id = ?`,
        [jobId, userId]
      );

      const job = jobRows[0];

      if (!job) {
        return;
      }

      const [profileRow] = await sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId]);

      let resumeUpload: { name: string; mimeType: string; base64: string } | null = null;
      const resumeAssetId = profileRow?.resume_asset_id ? String(profileRow.resume_asset_id) : null;

      if (resumeAssetId) {
        const pdfRows = await sqlite.all<{ filename: string; mime_type: string; file_blob: unknown }>(
          `SELECT filename, mime_type, file_blob FROM assets WHERE id = ? AND user_id = ? AND kind = 'resume_pdf'`,
          [resumeAssetId, userId]
        );
        const asset = pdfRows[0];
        const fb = asset?.file_blob;

        if (asset && fb instanceof Uint8Array && fb.byteLength > 0) {
          let binary = "";
          const chunk = 0x8000;

          for (let i = 0; i < fb.length; i += chunk) {
            binary += String.fromCharCode(...fb.subarray(i, i + chunk));
          }

          resumeUpload = {
            name: asset.filename,
            mimeType: asset.mime_type,
            base64: btoa(binary)
          };
        }
      }

      const contextBlock = profileRow ? formatProfileBlock(profileRow) : "";

      let linkedinLinks: string[] = [];

      try {
        linkedinLinks = JSON.parse(String(job.linkedin_links ?? "[]")) as string[];
      } catch {
        linkedinLinks = [];
      }

      let hiringContacts: string[] = [];

      try {
        hiringContacts = JSON.parse(String(job.hiring_contacts ?? "[]")) as string[];
      } catch {
        hiringContacts = [];
      }

      const sessionId = crypto.randomUUID();
      const applyUrlNormalized = normalizeApplyUrl(String(job.apply_url));

      const payload = {
        id: sessionId,
        jobId,
        title: String(job.source_title ?? ""),
        company: String(job.company ?? ""),
        companyHomepage: String(job.company_homepage ?? ""),
        applyUrl: applyUrlNormalized,
        contextBlock,
        listingText: String(job.listing_text ?? ""),
        resumeText: "",
        writingSample: String(profileRow?.essay ?? ""),
        coverLetterTemplate: String(profileRow?.cover_letter_template ?? ""),
        coverLetterText: "",
        candidateEmail: String(profileRow?.email ?? "").trim(),
        candidateFullName: String(profileRow?.full_name ?? "").trim(),
        resumeUpload,
        coverUpload: null,
        linkedinLinks: Array.isArray(linkedinLinks) ? linkedinLinks.map(String) : [],
        hiringContacts: Array.isArray(hiringContacts) ? hiringContacts.map(String) : [],
        answerPageHtml:
          "<!doctype html><html><head><meta charset=\"utf-8\"><title>JobMate</title></head><body></body></html>"
      };

      const res = await fetch(`${window.location.origin}/api/chrome-apply/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey, geminiModel, payload })
      });

      const data = (await res.json()) as { error?: string; payloadUrl?: string };

      if (!res.ok) {
        window.alert(data.error ?? `Chrome session failed (${res.status})`);
        return;
      }

      const payloadUrl = data.payloadUrl;

      if (!payloadUrl) {
        window.alert("Chrome session missing payload URL.");
        return;
      }

      const u = new URL(applyUrlNormalized);
      u.hash = `jobmatePayload=${encodeURIComponent(payloadUrl)}`;
      const applyTabUrl = u.toString();

      setApplySession({
        jobId,
        company: String(job.company),
        sourceTitle: String(job.source_title),
        applyUrl: applyUrlNormalized,
        status: "Opening apply tab…",
        needsAttention: false,
        attentionMessage: "",
        attentionInstruction: "",
        kind: ""
      });

      try {
        await openBackgroundTabViaExtension(applyTabUrl, payloadUrl);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setApplySession(null);
        return;
      }

      setApplySession((prev) => (prev ? { ...prev, status: "Applying…" } : prev));
    },
    [sqlite, userId, applySession]
  );

  async function deleteJobRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    await sqlite.run(`DELETE FROM jobs WHERE id = ? AND user_id = ?`, [jobId, userId]);
    bumpData();
  }

  async function doneApplying() {
    if (!sqlite || !userId || !applySession) {
      return;
    }
    await markAppliedRow(applySession.jobId, applySession.applyUrl);
    setApplySession(null);
  }

  async function runEmailSync() {
    if (!sqlite || !userId) {
      return;
    }

    const gemRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [SETTING_GEMINI_API_KEY]);
    const modRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [SETTING_GEMINI_MODEL]);
    const geminiApiKey = gemRows[0]?.value?.trim() ?? "";
    const geminiModel = modRows[0]?.value?.trim() || "gemini-3.1-flash-lite";

    const profileRows = await sqlite.all<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [userId]);
    const applyEmail = profileRows[0]?.email?.trim() ?? "";

    if (!applyEmail) {
      toast.error("No email configured in your profile.");
      return;
    }

    const domain = applyEmail.split("@")[1]?.toLowerCase() ?? "";
    let webmailUrl = "";

    if (domain === "gmail.com" || domain === "googlemail.com") {
      webmailUrl = "https://mail.google.com/mail/u/0/#inbox";
    } else if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
      webmailUrl = "https://outlook.live.com/mail/0/inbox";
    } else if (domain === "yahoo.com" || domain === "ymail.com") {
      webmailUrl = "https://mail.yahoo.com/";
    } else if (domain === "proton.me" || domain === "protonmail.com") {
      webmailUrl = "https://mail.proton.me/u/0/inbox";
    } else {
      webmailUrl = `https://mail.google.com/mail/u/0/#inbox`;
    }

    setEmailSyncBusy(true);
    toast.info("Opening email inbox…");

    try {
      const requestId = crypto.randomUUID();
      const text = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          window.removeEventListener("message", onReply);
          reject(new Error("Email sync timed out."));
        }, 60_000);

        function onReply(ev: MessageEvent) {
          const d = ev.data as { source?: string; requestId?: string; ok?: boolean; text?: string; error?: string | null };
          if (!d || d.source !== "jobmate-extension" || d.requestId !== requestId) return;
          window.removeEventListener("message", onReply);
          window.clearTimeout(timer);
          if (!d.ok) { reject(new Error(d.error || "Email sync failed.")); return; }
          resolve(d.text ?? "");
        }

        window.addEventListener("message", onReply);
        window.postMessage({ source: "jobmate-web", type: "JOBMATE_EMAIL_SYNC", requestId, url: webmailUrl }, "*");
      });

      const appliedJobs = await sqlite.all<{ id: string; company: string; source_title: string; applied_at: string }>(
        `SELECT id, company, source_title, applied_at FROM jobs WHERE user_id = ? AND status = 'applied' AND applied_at IS NOT NULL`,
        [userId]
      );

      if (!appliedJobs.length) {
        toast.info("No applied jobs to check.");
        return;
      }

      toast.info("Classifying emails…");

      const updates = await classifyJobEmailStatus({
        geminiApiKey,
        geminiModel,
        jobs: appliedJobs.map((j) => ({
          id: j.id,
          company: j.company,
          sourceTitle: j.source_title,
          appliedAt: j.applied_at
        })),
        inboxText: text
      });

      const now = new Date().toISOString();
      let updatedCount = 0;

      for (const u of updates) {
        if (u.emailStatus !== null) {
          await sqlite.run(`UPDATE jobs SET email_status = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
            u.emailStatus,
            now,
            u.jobId,
            userId
          ]);
          updatedCount++;
        }
      }

      bumpData();
      toast.success(`Email sync complete. ${updatedCount} job${updatedCount !== 1 ? "s" : ""} updated.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEmailSyncBusy(false);
    }
  }

  async function fetchJobContacts(job: ResultJobRow) {
    if (!sqlite || userId === null) {
      throw new Error("Database not ready.");
    }

    const serpRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
      SETTING_SERPAPI_API_KEY
    ]);
    const serpApiKey = serpRows[0]?.value?.trim() ?? "";

    const res = await fetch("/api/job-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serpApiKey,
        company: job.company,
        listingText: job.listing_text,
        sourceUrl: job.source_url,
        parsedHomepage: job.company_homepage
      })
    });

    const data = (await res.json()) as {
      error?: string;
      linkedinLinks?: string[];
      hiringContacts?: string[];
      companyHomepage?: string | null;
    };

    if (!res.ok) {
      throw new Error(data.error ?? `Contacts fetch failed (${res.status})`);
    }

    const linkedinLinks = Array.isArray(data.linkedinLinks) ? data.linkedinLinks.map(String) : [];
    const hiringContacts = Array.isArray(data.hiringContacts) ? data.hiringContacts.map(String) : [];
    const now = new Date().toISOString();

    await sqlite.run(
      `UPDATE jobs SET linkedin_links = ?, hiring_contacts = ?, company_homepage = COALESCE(?, company_homepage), updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(linkedinLinks), JSON.stringify(hiringContacts), data.companyHomepage ?? null, now, job.id, userId]
    );
    bumpData();

    return { linkedinLinks, hiringContacts };
  }

  const filteredResults = useMemo(() => {
    const list =
      resultsPrefFilter === "all" ? resultJobs : resultJobs.filter((j) => j.preference_id === resultsPrefFilter);
    const bestByApply = new Map<string, ResultJobRow>();

    for (const j of list) {
      const key = normalizeApplyUrl(j.apply_url);
      const prev = bestByApply.get(key);

      if (!prev || j.discovered_at > prev.discovered_at) {
        bestByApply.set(key, j);
      }
    }

    return Array.from(bestByApply.values()).sort((a, b) =>
      a.discovered_at < b.discovered_at ? 1 : a.discovered_at > b.discovered_at ? -1 : 0
    );
  }, [resultJobs, resultsPrefFilter]);

  if (error) {
    return (
      <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <p className="text-sm text-gray-500 dark:text-gray-400">Gathering data…</p>
      </div>
    );
  }

  if (userBootstrap === "pending") {
    return (
      <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      </div>
    );
  }

  if (userId === null) {
    if (fetchError) {
      return (
        <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>
        </div>
      );
    }

    if (!sqlite) {
      return (
        <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      );
    }

    return <BrowserProfileWizard sqlite={sqlite} onCreatedUserId={setUserId} />;
  }

  if (!setupGateResolved) {
    return (
      <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      </div>
    );
  }

  if (!setupComplete) {
    if (!sqlite) {
      return (
        <div className="min-h-screen bg-white px-6 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      );
    }

    return (
      <BrowserSetupWizard
        sqlite={sqlite}
        userId={userId}
        onDone={() => {
          setSetupComplete(true);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {applySession ? (
        <ApplySessionBadge
          session={applySession}
          onDismiss={() => setApplySession(null)}
          onDoneApplying={() => void doneApplying()}
        />
      ) : null}
      <aside className="flex w-52 shrink-0 flex-col border-r border-gray-200 dark:border-gray-800">
        <div className="border-b border-gray-200 px-4 py-5 dark:border-gray-800">
          <h1 className="text-lg font-semibold tracking-tight">JobMate</h1>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${page === item.id
                ? "bg-gray-100 font-medium dark:bg-gray-900"
                : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900/60"
                }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className={`flex-1 overflow-auto px-8 py-10 ${page === "results" ? "min-w-0" : ""}`}>
        {fetchError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>
        ) : busy ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : page === "home" ? (
          <HomePanel
            profile={profile}
            prefCount={prefCount}
            statusCounts={statusCounts}
            openJobsCount={openJobsCount}
            ingestRunning={ingestRunning}
            onRunSearch={runSearchPipeline}
          />
        ) : page === "targets" ? (
          <TargetsPanel
            prefs={prefs}
            onAdd={() => setPrefModal({ mode: "add", row: null })}
            onEdit={async (id) => {
              const row = await loadPreferenceRow(id);
              if (row) {
                setPrefModal({ mode: "edit", row });
              }
            }}
            onToggle={togglePreferenceEnabled}
            onDelete={deletePreference}
            confirmClearHistory={confirmClearHistory}
            setConfirmClearHistory={setConfirmClearHistory}
            onClearHistory={clearJobHistory}
          />
        ) : page === "results" ? (
          <ResultsPanel
            prefs={prefs}
            jobs={filteredResults}
            filter={resultsPrefFilter}
            onFilter={setResultsPrefFilter}
            onArchive={archiveJobRow}
            onMarkApplied={markAppliedRow}
            onChromeApply={openChromeApplyForJob}
            onFetchContacts={fetchJobContacts}
          />
        ) : page === "statuses" ? (
          <StatusesPanel
            bucket={statusBucket}
            onBucket={setStatusBucket}
            jobs={bucketJobs}
            onRestore={statusBucket === "archived" ? unarchiveRow : unapplyRow}
            onDelete={deleteJobRow}
            emailSyncBusy={emailSyncBusy}
            onEmailSync={() => void runEmailSync()}
          />
        ) : page === "metrics" ? (
          <MetricsPanel rows={metricRows} />
        ) : (
          <ConfigPanel sqlite={sqlite} userId={userId} profile={profile} bumpData={bumpData} dataEpoch={dataEpoch} />
        )}
      </main>
      {prefModal && sqlite && userId ? (
        <PreferenceEditorModal
          key={`${prefModal.mode}-${prefModal.mode === "edit" ? String(prefModal.row?.id ?? "") : "new"}`}
          sqlite={sqlite}
          userId={userId}
          mode={prefModal.mode}
          initial={prefModal.row}
          onClose={() => setPrefModal(null)}
          onSaved={bumpData}
        />
      ) : null}
    </div>
  );
}

function ApplySessionBadge(props: {
  session: {
    company: string;
    sourceTitle: string;
    status: string;
    needsAttention: boolean;
    attentionMessage: string;
    attentionInstruction: string;
    kind: string;
  };
  onDismiss: () => void;
  onDoneApplying: () => void;
}) {
  const { session, onDismiss, onDoneApplying } = props;
  const isAttention = session.needsAttention;

  return (
    <div className="fixed right-4 top-4 z-50 w-72 rounded-xl border shadow-lg bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className={`px-4 py-2 flex items-center justify-between ${isAttention ? "bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800" : "bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"}`}>
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {isAttention ? "⚠ Apply" : "▶ Apply"}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          ✕
        </button>
      </div>
      <div className="px-4 py-3 space-y-1">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{session.company}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{session.sourceTitle}</p>
        <p className={`text-xs mt-1 ${isAttention ? "text-amber-700 dark:text-amber-400 font-medium" : "text-gray-500 dark:text-gray-400"}`}>
          {session.status}
        </p>
        {isAttention && session.attentionMessage ? (
          <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">{session.attentionMessage}</p>
        ) : null}
        {isAttention && session.attentionInstruction ? (
          <p className="text-xs text-gray-500 dark:text-gray-400 italic">{session.attentionInstruction}</p>
        ) : null}
      </div>
      {isAttention ? (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={onDoneApplying}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Done applying
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HomePanel(props: {
  profile: Record<string, unknown> | null;
  prefCount: number;
  statusCounts: { status: string; n: number }[];
  openJobsCount: number;
  ingestRunning: boolean;
  onRunSearch: () => void;
}) {
  const {
    profile,
    prefCount,
    statusCounts,
    openJobsCount,
    ingestRunning,
    onRunSearch
  } = props;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Home</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Profile, counts, and search pipeline.</p>
      </div>
      <section className="rounded-xl border border-gray-200 p-5 dark:border-gray-800">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Profile</h3>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-gray-500 dark:text-gray-400">Email</dt>
            <dd>{profile ? String(profile.email ?? "") : ""}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-gray-500 dark:text-gray-400">Name</dt>
            <dd>{profile ? String(profile.full_name ?? "") : ""}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-gray-500 dark:text-gray-400">Location</dt>
            <dd>{profile ? String(profile.location ?? "") : ""}</dd>
          </div>
        </dl>
      </section>
      <section className="flex flex-wrap gap-4">
        <div className="rounded-xl border border-gray-200 px-5 py-4 dark:border-gray-800">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Targets</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{prefCount}</p>
        </div>
        <div className="rounded-xl border border-gray-200 px-5 py-4 dark:border-gray-800">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Open jobs</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{openJobsCount}</p>
        </div>
        {statusCounts.map((row) => (
          <div
            key={row.status}
            className="rounded-xl border border-gray-200 px-5 py-4 dark:border-gray-800"
          >
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{row.status}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{row.n}</p>
          </div>
        ))}
      </section>
      <section className="rounded-xl border border-gray-200 p-5 dark:border-gray-800">
        <button
          type="button"
          disabled={ingestRunning}
          onClick={() => void onRunSearch()}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          {ingestRunning ? "Running search pipeline…" : "Run search pipeline"}
        </button>
      </section>
    </div>
  );
}

function TargetsPanel(props: {
  prefs: { id: string; title: string; enabled: number; updated_at: string }[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  confirmClearHistory: boolean;
  setConfirmClearHistory: (v: boolean) => void;
  onClearHistory: () => void;
}) {
  const {
    prefs,
    onAdd,
    onEdit,
    onToggle,
    onDelete,
    confirmClearHistory,
    setConfirmClearHistory,
    onClearHistory
  } = props;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Targets</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Add, edit, enable, or delete search targets.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onAdd}
            className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900"
          >
            Add target
          </button>
          {confirmClearHistory ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmClearHistory(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onClearHistory()}
                className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
              >
                Confirm clear history
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClearHistory(true)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700"
            >
              Clear applied &amp; archived jobs
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {prefs.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No targets yet.</li>
        ) : (
          prefs.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{p.title}</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{p.id}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.enabled ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                >
                  {p.enabled ? "enabled" : "disabled"}
                </span>
                <button
                  type="button"
                  onClick={() => void onToggle(p.id, !p.enabled)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs dark:border-gray-700"
                >
                  Toggle
                </button>
                <button
                  type="button"
                  onClick={() => void onEdit(p.id)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs dark:border-gray-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(p.id)}
                  className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function CliJobDetailSections(props: {
  panel: "results" | "statuses";
  summary: string;
  compensationRange: string | null;
  location: string;
  companyHomepage: string | null;
  sourceUrl: string;
  listingText: string;
  discoveredAt: string;
  linkedinLinks: string[];
  hiringContacts: string[];
  appliedAt?: string | null;
  appliedApplicationUrl?: string | null;
  appliedLinkedinSnapshot?: string[];
  appliedContactsSnapshot?: string[];
}) {
  const snapLi =
    props.appliedLinkedinSnapshot && props.appliedLinkedinSnapshot.length > 0
      ? props.appliedLinkedinSnapshot
      : props.linkedinLinks;
  const snapCt =
    props.appliedContactsSnapshot && props.appliedContactsSnapshot.length > 0
      ? props.appliedContactsSnapshot
      : props.hiringContacts;
  const applicationUrl = String(props.appliedApplicationUrl ?? "").trim();

  return (
    <div className="mt-3 space-y-3 border-t border-gray-200 pt-3 text-sm dark:border-gray-800">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Summary</p>
        <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-200">
          {props.summary.trim() ? props.summary : "No summary available."}
        </p>
      </div>
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        {props.panel === "results" ? (
          <div className="flex gap-2 sm:col-span-2">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">Retrieved</dt>
            <dd className="text-gray-800 dark:text-gray-200">{props.discoveredAt}</dd>
          </div>
        ) : null}
        {props.panel === "statuses" && props.appliedAt ? (
          <div className="flex gap-2 sm:col-span-2">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">Applied</dt>
            <dd className="text-gray-800 dark:text-gray-200">{props.appliedAt}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">Comp</dt>
          <dd className="text-gray-800 dark:text-gray-200">{props.compensationRange?.trim() ? props.compensationRange : "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">Location</dt>
          <dd className="text-gray-800 dark:text-gray-200">{props.location.trim() ? props.location : "Unknown"}</dd>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">Homepage</dt>
          <dd className="min-w-0 break-all">
            {props.companyHomepage?.trim() ? (
              <a
                href={props.companyHomepage.trim()}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline dark:text-blue-400"
              >
                {props.companyHomepage.trim()}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
        {props.panel === "statuses" && applicationUrl ? (
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">Application URL</dt>
            <dd className="min-w-0 break-all">
              <a href={applicationUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400">
                {applicationUrl}
              </a>
            </dd>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <dt className="shrink-0 text-gray-500 dark:text-gray-400">Listing</dt>
          <dd className="min-w-0 break-all">
            <a href={props.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400">
              {props.sourceUrl}
            </a>
          </dd>
        </div>
      </dl>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">LinkedIn</p>
        <ul className="mt-1 list-inside list-disc space-y-1 break-all text-gray-800 dark:text-gray-200">
          {snapLi.length ? (
            snapLi.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400">
                  {link}
                </a>
              </li>
            ))
          ) : (
            <li className="list-none text-gray-500 dark:text-gray-400">Not found.</li>
          )}
        </ul>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Hiring contacts</p>
        <ul className="mt-1 list-inside list-disc space-y-1 break-all text-gray-800 dark:text-gray-200">
          {snapCt.length ? (
            snapCt.map((c) => (
              <li key={c}>
                {c.includes("@") ? (
                  <a href={`mailto:${c}`} className="text-blue-700 underline dark:text-blue-400">
                    {c}
                  </a>
                ) : (
                  c
                )}
              </li>
            ))
          ) : (
            <li className="list-none text-gray-500 dark:text-gray-400">Not found.</li>
          )}
        </ul>
      </div>
      <details className="rounded-md border border-gray-200 dark:border-gray-800">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-400">
          Full listing text
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-800 dark:bg-gray-900/50">
          {props.listingText}
        </pre>
      </details>
    </div>
  );
}


function emailStatusLabel(s: string | null): { label: string; color: string } | null {
  if (!s) return null;
  if (s === "rejected") return { label: "Rejected", color: "text-red-600 dark:text-red-400" };
  if (s === "waiting") return { label: "Waiting for response", color: "text-blue-600 dark:text-blue-400" };
  if (s === "needs_action") return { label: "Needs attention", color: "text-amber-600 dark:text-amber-400" };
  return null;
}

function StatusesPanel(props: {
  bucket: "archived" | "applied";
  onBucket: (b: "archived" | "applied") => void;
  jobs: BucketJobRow[];
  onRestore: (jobId: string) => void;
  onDelete: (jobId: string) => void;
  emailSyncBusy: boolean;
  onEmailSync: () => void;
}) {
  const { bucket, onBucket, jobs, onRestore, onDelete, emailSyncBusy, onEmailSync } = props;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Statuses</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Archived and dismissed, or applied jobs.</p>
        </div>
        {bucket === "applied" ? (
          <button
            type="button"
            onClick={onEmailSync}
            disabled={emailSyncBusy}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {emailSyncBusy ? "Syncing…" : "Email sync"}
          </button>
        ) : null}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onBucket("archived")}
          className={`rounded-full px-3 py-1 text-sm ${bucket === "archived"
            ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
            : "border border-gray-300 dark:border-gray-700"
            }`}
        >
          Archived / dismissed
        </button>
        <button
          type="button"
          onClick={() => onBucket("applied")}
          className={`rounded-full px-3 py-1 text-sm ${bucket === "applied"
            ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
            : "border border-gray-300 dark:border-gray-700"
            }`}
        >
          Applied
        </button>
      </div>
      <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {jobs.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No jobs in this bucket.</li>
        ) : (
          jobs.map((j) => {
            const linkedins = parseStoredJsonStrings(j.linkedin_links);
            const contacts = parseStoredJsonStrings(j.hiring_contacts);
            const snapLi = parseStoredJsonStrings(j.applied_at_linkedin_links);
            const snapCt = parseStoredJsonStrings(j.applied_at_hiring_contacts);
            const applicationUrl = String(j.applied_application_url ?? "").trim() || j.apply_url;

            const emailBadge = emailStatusLabel(j.email_status);

            return (
              <li key={j.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{j.company}</p>
                  <div className="flex items-center gap-2">
                    {emailBadge ? (
                      <span className={`text-xs font-medium ${emailBadge.color}`}>{emailBadge.label}</span>
                    ) : null}
                    <span className="text-xs text-gray-500 dark:text-gray-400">{j.status}</span>
                  </div>
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300">{j.source_title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {j.applied_at ?? j.archived_at ?? j.discovered_at}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onRestore(j.id)}
                    className="text-sm text-blue-700 underline dark:text-blue-400"
                  >
                    {bucket === "archived" ? "Unarchive" : "Unapply"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(j.id)}
                    className="text-sm text-red-700 underline dark:text-red-400"
                  >
                    Delete
                  </button>
                </div>
                <CliJobDetailSections
                  panel="statuses"
                  summary={j.summary}
                  compensationRange={j.compensation_range}
                  location={j.location}
                  companyHomepage={j.company_homepage}
                  sourceUrl={j.source_url}
                  listingText={j.listing_text}
                  discoveredAt={j.discovered_at}
                  linkedinLinks={linkedins}
                  hiringContacts={contacts}
                  appliedAt={j.applied_at}
                  appliedApplicationUrl={bucket === "applied" ? applicationUrl : null}
                  appliedLinkedinSnapshot={snapLi}
                  appliedContactsSnapshot={snapCt}
                />
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function MetricsPanel(props: { rows: { day: string; retrieved: number; applied: number }[] }) {
  const { rows } = props;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Metrics</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Daily retrieved vs applied (last 14 days).</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
              <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-400">Day</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-400">Retrieved</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-400">Applied</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  No metric rows yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.day} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="px-4 py-2">{r.day}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.retrieved}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.applied}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function configFieldStatus(value: string, options?: { secret?: boolean; multiline?: boolean }) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Not set";
  }
  if (options?.secret) {
    return `Configured (${trimmed.length} characters)`;
  }
  if (options?.multiline) {
    const oneLine = trimmed.replace(/\s+/g, " ");
    return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
  }
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed;
}

function ConfigPanel(props: {
  sqlite: JobmateSqlite | null;
  userId: string | null;
  profile: Record<string, unknown> | null;
  bumpData: () => void;
  dataEpoch: number;
}) {
  const { sqlite, userId, profile, bumpData, dataEpoch } = props;
  const [language, setLanguage] = useState<"en" | "fr">("en");
  const [serpApiKey, setSerpApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3.1-flash-lite");
  const [webhook, setWebhook] = useState("");
  const [applyEmail, setApplyEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [currentLocation, setCurrentLocation] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [preferredCompRange, setPreferredCompRange] = useState("");
  const [coverLetterTemplate, setCoverLetterTemplate] = useState("");
  const [workHistory, setWorkHistory] = useState("");
  const [skills, setSkills] = useState("");
  const [essay, setEssay] = useState("");
  const [savedLanguage, setSavedLanguage] = useState<"en" | "fr">("en");
  const [savedSerpApiKey, setSavedSerpApiKey] = useState("");
  const [savedGeminiApiKey, setSavedGeminiApiKey] = useState("");
  const [savedGeminiModel, setSavedGeminiModel] = useState("gemini-3.1-flash-lite");
  const [savedWebhook, setSavedWebhook] = useState("");
  const [savedApplyEmail, setSavedApplyEmail] = useState("");
  const [savedFullName, setSavedFullName] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [savedWebsite, setSavedWebsite] = useState("");
  const [savedCurrentLocation, setSavedCurrentLocation] = useState("");
  const [savedPhone, setSavedPhone] = useState("");
  const [savedLinkedinUrl, setSavedLinkedinUrl] = useState("");
  const [savedPreferredCompRange, setSavedPreferredCompRange] = useState("");
  const [savedCoverLetterTemplate, setSavedCoverLetterTemplate] = useState("");
  const [savedWorkHistory, setSavedWorkHistory] = useState("");
  const [savedSkills, setSavedSkills] = useState("");
  const [savedEssay, setSavedEssay] = useState("");
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [resumeLabel, setResumeLabel] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);

  useEffect(() => {
    if (!sqlite || !userId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const langRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_LANGUAGE
      ]);
      const serp = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_SERPAPI_API_KEY
      ]);
      const gem = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_API_KEY
      ]);
      const mod = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_MODEL
      ]);
      const hook = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_NOTIFICATION_WEBHOOK_URL
      ]);
      const apply = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_APPLY_EMAIL
      ]);

      if (cancelled) {
        return;
      }

      const nextLanguage = langRows[0]?.value === "fr" ? "fr" : "en";
      const nextSerp = serp[0]?.value ?? "";
      const nextGem = gem[0]?.value ?? "";
      const nextModel = mod[0]?.value?.trim() ? String(mod[0].value) : "gemini-3.1-flash-lite";
      const nextWebhook = hook[0]?.value ?? "";
      const nextApplyEmail = apply[0]?.value ?? "";

      setLanguage(nextLanguage);
      setSerpApiKey(nextSerp);
      setGeminiApiKey(nextGem);
      setGeminiModel(nextModel);
      setWebhook(nextWebhook);
      setApplyEmail(nextApplyEmail);
      setSavedLanguage(nextLanguage);
      setSavedSerpApiKey(nextSerp);
      setSavedGeminiApiKey(nextGem);
      setSavedGeminiModel(nextModel);
      setSavedWebhook(nextWebhook);
      setSavedApplyEmail(nextApplyEmail);
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId, dataEpoch]);

  useEffect(() => {
    if (!profile) {
      return;
    }

    const nextFullName = String(profile.full_name ?? "");
    const nextEmail = String(profile.email ?? "");
    const nextWebsite = String(profile.website ?? "");
    const nextCurrentLocation = String(profile.current_location ?? profile.location ?? "");
    const nextPhone = String(profile.phone ?? "");
    const nextLinkedinUrl = String(profile.linkedin_url ?? "");
    const nextPreferredCompRange = String(profile.preferred_comp_range ?? "");
    const nextCoverLetterTemplate = String(profile.cover_letter_template ?? "");
    const nextWorkHistory = String(profile.work_history ?? "");
    const nextSkills = String(profile.skills ?? "");
    const nextEssay = String(profile.essay ?? "");

    setFullName(nextFullName);
    setEmail(nextEmail);
    setWebsite(nextWebsite);
    setCurrentLocation(nextCurrentLocation);
    setPhone(nextPhone);
    setLinkedinUrl(nextLinkedinUrl);
    setPreferredCompRange(nextPreferredCompRange);
    setCoverLetterTemplate(nextCoverLetterTemplate);
    setWorkHistory(nextWorkHistory);
    setSkills(nextSkills);
    setEssay(nextEssay);
    setSavedFullName(nextFullName);
    setSavedEmail(nextEmail);
    setSavedWebsite(nextWebsite);
    setSavedCurrentLocation(nextCurrentLocation);
    setSavedPhone(nextPhone);
    setSavedLinkedinUrl(nextLinkedinUrl);
    setSavedPreferredCompRange(nextPreferredCompRange);
    setSavedCoverLetterTemplate(nextCoverLetterTemplate);
    setSavedWorkHistory(nextWorkHistory);
    setSavedSkills(nextSkills);
    setSavedEssay(nextEssay);
  }, [profile]);

  useEffect(() => {
    if (!sqlite || !userId || !profile?.resume_asset_id) {
      setResumeLabel(null);
      return;
    }

    const rid = String(profile.resume_asset_id);
    let cancelled = false;

    void sqlite
      .all<{ filename: string }>(`SELECT filename FROM assets WHERE id = ? AND user_id = ?`, [rid, userId])
      .then((rows) => {
        if (!cancelled) {
          setResumeLabel(rows[0]?.filename ?? rid);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId, profile?.resume_asset_id]);

  async function saveApiSettings() {
    if (!sqlite) {
      return;
    }

    setCfgBusy(true);
    setCfgMsg(null);

    try {
      const nextLanguage = language;
      const nextSerp = serpApiKey.trim();
      const nextGem = geminiApiKey.trim();
      const nextModel = geminiModel.trim() || "gemini-3.1-flash-lite";
      const nextWebhook = webhook.trim();
      const nextApplyEmail = applyEmail.trim();

      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_LANGUAGE, nextLanguage]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_SERPAPI_API_KEY, nextSerp]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_GEMINI_API_KEY, nextGem]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_GEMINI_MODEL, nextModel]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_NOTIFICATION_WEBHOOK_URL,
        nextWebhook
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_APPLY_EMAIL, nextApplyEmail]);

      setSavedLanguage(nextLanguage);
      setSavedSerpApiKey(nextSerp);
      setSavedGeminiApiKey(nextGem);
      setSavedGeminiModel(nextModel);
      setSavedWebhook(nextWebhook);
      setSavedApplyEmail(nextApplyEmail);
      setCfgMsg("API settings saved.");
      bumpData();
    } catch (e) {
      setCfgMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCfgBusy(false);
    }
  }

  async function saveProfile() {
    if (!sqlite || !userId) {
      return;
    }

    const em = email.trim().toLowerCase();
    const fn = fullName.trim();

    if (!em || !fn) {
      setCfgMsg("Full name and email are required.");
      return;
    }

    setCfgBusy(true);
    setCfgMsg(null);

    try {
      const now = new Date().toISOString();
      const loc = currentLocation.trim();
      const nextWebsite = website.trim();
      const nextPhone = phone.trim();
      const nextLinkedinUrl = linkedinUrl.trim();
      const nextPreferredCompRange = preferredCompRange.trim();
      const nextCoverLetterTemplate = coverLetterTemplate.trim();
      const nextWorkHistory = workHistory.trim();
      const nextSkills = skills.trim();
      const nextEssay = essay.trim();

      await sqlite.run(
        `UPDATE users SET email = ?, full_name = ?, location = ?, current_location = ?, phone = ?, linkedin_url = ?, preferred_comp_range = ?, cover_letter_template = ?, website = ?, work_history = ?, skills = ?, essay = ?, updated_at = ?
         WHERE id = ?`,
        [
          em,
          fn,
          loc,
          loc,
          nextPhone,
          nextLinkedinUrl,
          nextPreferredCompRange,
          nextCoverLetterTemplate,
          nextWebsite,
          nextWorkHistory,
          nextSkills,
          nextEssay,
          now,
          userId
        ]
      );

      setSavedFullName(fn);
      setSavedEmail(em);
      setSavedWebsite(nextWebsite);
      setSavedCurrentLocation(loc);
      setSavedPhone(nextPhone);
      setSavedLinkedinUrl(nextLinkedinUrl);
      setSavedPreferredCompRange(nextPreferredCompRange);
      setSavedCoverLetterTemplate(nextCoverLetterTemplate);
      setSavedWorkHistory(nextWorkHistory);
      setSavedSkills(nextSkills);
      setSavedEssay(nextEssay);
      setCfgMsg("Profile saved.");
      bumpData();
    } catch (e) {
      setCfgMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCfgBusy(false);
    }
  }

  if (!sqlite || !userId) {
    return null;
  }

  const fi =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
  const lb = "block text-sm font-medium text-gray-700 dark:text-gray-300";
  const st = "mt-1 text-xs text-gray-500 dark:text-gray-400";

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Config</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">API keys, profile, and Chrome extension download.</p>
      </div>

      <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
        <h3 className="text-sm font-semibold">Chrome extension</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Download the unpacked extension, then in Chrome open chrome://extensions, enable Developer mode, choose Load unpacked,
          and extract the zip.
        </p>
        <a
          href="/chrome-extension.zip"
          download
          className="mt-3 inline-block text-sm font-medium text-blue-700 underline dark:text-blue-400"
        >
          Download chrome-extension.zip
        </a>
      </section>

      <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
        <h3 className="text-sm font-semibold">Resume PDF</h3>
        <p className="mt-2 text-sm text-gray-800 dark:text-gray-200">
          {resumeLabel ? `Current file: ${resumeLabel}` : "No resume on profile yet."}
        </p>
        <input
          type="file"
          accept="application/pdf"
          disabled={resumeBusy || cfgBusy}
          className={`${fi} mt-2`}
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = "";

            if (!f || !sqlite || !userId) {
              return;
            }

            setResumeBusy(true);

            void insertResumePdfAsset(sqlite, userId, f)
              .then((id) => setUserResumeAsset(sqlite, userId, id))
              .then(() => {
                setCfgMsg("Resume saved on profile.");
                bumpData();
              })
              .catch((e) => {
                setCfgMsg(e instanceof Error ? e.message : String(e));
              })
              .finally(() => {
                setResumeBusy(false);
              });
          }}
        />
        {profile?.resume_asset_id ? (
          <button
            type="button"
            disabled={resumeBusy || cfgBusy || !sqlite || !userId}
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700"
            onClick={() => {
              if (!sqlite || !userId) {
                return;
              }

              setResumeBusy(true);

              void setUserResumeAsset(sqlite, userId, null)
                .then(() => {
                  setCfgMsg("Resume removed from profile.");
                  bumpData();
                })
                .catch((e) => {
                  setCfgMsg(e instanceof Error ? e.message : String(e));
                })
                .finally(() => {
                  setResumeBusy(false);
                });
            }}
          >
            Remove resume from profile
          </button>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
        <h3 className="text-sm font-semibold">API keys</h3>
        <div>
          <span className={lb}>Language</span>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={language === "en"} onChange={() => setLanguage("en")} />
              English
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={language === "fr"} onChange={() => setLanguage("fr")} />
              Français
            </label>
          </div>
          <p className={st}>Saved: {savedLanguage === "fr" ? "Français" : "English"}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-serp">
            SerpApi API key
          </label>
          <input id="cf-serp" className={fi} value={serpApiKey} onChange={(ev) => setSerpApiKey(ev.target.value)} autoComplete="off" />
          <p className={st}>Saved: {configFieldStatus(savedSerpApiKey, { secret: true })}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-gem">
            Gemini API key
          </label>
          <input id="cf-gem" className={fi} value={geminiApiKey} onChange={(ev) => setGeminiApiKey(ev.target.value)} autoComplete="off" />
          <p className={st}>Saved: {configFieldStatus(savedGeminiApiKey, { secret: true })}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-mod">
            Gemini model
          </label>
          <input id="cf-mod" className={fi} value={geminiModel} onChange={(ev) => setGeminiModel(ev.target.value)} autoComplete="off" />
          <p className={st}>Saved: {configFieldStatus(savedGeminiModel)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-wh">
            Webhook URL (digest notifications)
          </label>
          <input id="cf-wh" className={fi} value={webhook} onChange={(ev) => setWebhook(ev.target.value)} autoComplete="off" />
          <p className={st}>Saved: {configFieldStatus(savedWebhook)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-apply-email">
            Apply email (registration)
          </label>
          <input id="cf-apply-email" type="email" className={fi} value={applyEmail} onChange={(ev) => setApplyEmail(ev.target.value)} autoComplete="off" />
          <p className={st}>Saved: {configFieldStatus(savedApplyEmail)}</p>
        </div>
        <button
          type="button"
          disabled={cfgBusy}
          onClick={() => void saveApiSettings()}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          Save API settings
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
        <h3 className="text-sm font-semibold">Profile</h3>
        <div>
          <label className={lb} htmlFor="cf-fn">
            Full name
          </label>
          <input id="cf-fn" className={fi} value={fullName} onChange={(ev) => setFullName(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedFullName)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-em">
            Email
          </label>
          <input id="cf-em" type="email" className={fi} value={email} onChange={(ev) => setEmail(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedEmail)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-site">
            Website
          </label>
          <input id="cf-site" className={fi} value={website} onChange={(ev) => setWebsite(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedWebsite)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-loc">
            Location
          </label>
          <input id="cf-loc" className={fi} value={currentLocation} onChange={(ev) => setCurrentLocation(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedCurrentLocation)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-ph">
            Phone
          </label>
          <input id="cf-ph" className={fi} value={phone} onChange={(ev) => setPhone(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedPhone)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-li">
            LinkedIn URL
          </label>
          <input id="cf-li" className={fi} value={linkedinUrl} onChange={(ev) => setLinkedinUrl(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedLinkedinUrl)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-comp">
            Preferred compensation range
          </label>
          <input id="cf-comp" className={fi} value={preferredCompRange} onChange={(ev) => setPreferredCompRange(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedPreferredCompRange)}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-cover">
            Cover letter template
          </label>
          <textarea id="cf-cover" rows={5} className={fi} value={coverLetterTemplate} onChange={(ev) => setCoverLetterTemplate(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedCoverLetterTemplate, { multiline: true })}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-whist">
            Work history
          </label>
          <textarea id="cf-whist" rows={6} className={fi} value={workHistory} onChange={(ev) => setWorkHistory(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedWorkHistory, { multiline: true })}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-sk">
            Skills
          </label>
          <textarea id="cf-sk" rows={3} className={fi} value={skills} onChange={(ev) => setSkills(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedSkills, { multiline: true })}</p>
        </div>
        <div>
          <label className={lb} htmlFor="cf-essay">
            Writing sample (essay)
          </label>
          <textarea id="cf-essay" rows={6} className={fi} value={essay} onChange={(ev) => setEssay(ev.target.value)} />
          <p className={st}>Saved: {configFieldStatus(savedEssay, { multiline: true })}</p>
        </div>
        <button
          type="button"
          disabled={cfgBusy}
          onClick={() => void saveProfile()}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          Save profile
        </button>
      </section>

      {cfgMsg ? <p className="text-sm text-gray-600 dark:text-gray-400">{cfgMsg}</p> : null}
    </div>
  );
}
