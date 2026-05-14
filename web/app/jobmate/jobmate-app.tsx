import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { normalizeApplyUrl } from "@/lib/apply-url";

import { runBrowserIngestion } from "./browser-ingest";
import {
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

type PageId = "home" | "targets" | "results" | "statuses" | "metrics" | "config";

const NAV: { id: PageId; label: string; key: string }[] = [
  { id: "home", label: "Home", key: "1" },
  { id: "targets", label: "Targets", key: "2" },
  { id: "results", label: "Results", key: "3" },
  { id: "statuses", label: "Statuses", key: "4" },
  { id: "metrics", label: "Metrics", key: "5" },
  { id: "config", label: "Config", key: "6" }
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

type ResultJobRow = {
  id: string;
  preference_id: string;
  company: string;
  source_title: string;
  status: string;
  discovered_at: string;
  apply_url: string;
  source_url: string;
  summary: string;
  listing_text: string;
  compensation_range: string | null;
  location: string;
  company_homepage: string | null;
  linkedin_links: string | null;
  hiring_contacts: string | null;
};

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

  const [setupGateResolved, setSetupGateResolved] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);

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
        const [u] = await sqlite.all<Record<string, unknown>>(
          "SELECT id, email, full_name, location, linkedin_url, phone, created_at, resume_asset_id FROM users WHERE id = ?",
          [userId]
        );
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
          `SELECT id, preference_id, company, source_title, status, discovered_at, apply_url,
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
            linkedin_links, hiring_contacts, applied_application_url, applied_at_linkedin_links, applied_at_hiring_contacts
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

  useEffect(() => {
    if (!setupComplete || userId === null) {
      return;
    }

    function onKey(ev: KeyboardEvent) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        return;
      }

      const m = NAV.find((n) => n.key === ev.key);

      if (m) {
        ev.preventDefault();
        setPage(m.id);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setupComplete, userId]);

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
        geminiModel: modRows[0]?.value?.trim() || "gemini-3-flash-preview",
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

      const gemRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_API_KEY
      ]);
      const modRows = await sqlite.all<{ value: string }>("SELECT value FROM kv_settings WHERE key = ?", [
        SETTING_GEMINI_MODEL
      ]);
      const geminiApiKey = gemRows[0]?.value?.trim() ?? "";
      const geminiModel = modRows[0]?.value?.trim() || "gemini-3-flash-preview";

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
      window.open(u.toString(), "_blank", "noopener,noreferrer");
    },
    [sqlite, userId]
  );

  async function deleteJobRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    await sqlite.run(`DELETE FROM jobs WHERE id = ? AND user_id = ?`, [jobId, userId]);
    bumpData();
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
              <span className="mr-2 font-mono text-xs text-gray-400 dark:text-gray-500">{item.key}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto px-8 py-10">
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
          />
        ) : page === "statuses" ? (
          <StatusesPanel
            bucket={statusBucket}
            onBucket={setStatusBucket}
            jobs={bucketJobs}
            onRestore={statusBucket === "archived" ? unarchiveRow : unapplyRow}
            onDelete={deleteJobRow}
          />
        ) : page === "metrics" ? (
          <MetricsPanel rows={metricRows} />
        ) : (
          <ConfigPanel sqlite={sqlite} userId={userId} profile={profile} bumpData={bumpData} />
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
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
          Discovery uses the JobMate Chrome extension for in-browser Google when available; otherwise SerpApi via server routes.
          Listing HTML is fetched server-side; parsing and Gemini field answers run in the browser.
        </p>
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

function ResultsPanel(props: {
  prefs: { id: string; title: string }[];
  jobs: ResultJobRow[];
  filter: string | "all";
  onFilter: (v: string | "all") => void;
  onArchive: (jobId: string) => void;
  onMarkApplied: (jobId: string, applyUrl: string) => void;
  onChromeApply: (jobId: string) => void | Promise<void>;
}) {
  const { prefs, jobs, filter, onFilter, onArchive, onMarkApplied, onChromeApply } = props;

  const prefTitle = (id: string) => prefs.find((p) => p.id === id)?.title ?? id;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Results</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Jobs in new or reviewed status.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onFilter("all")}
          className={`rounded-full px-3 py-1 text-sm ${filter === "all"
            ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
            : "border border-gray-300 dark:border-gray-700"
            }`}
        >
          All
        </button>
        {prefs.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onFilter(p.id)}
            className={`rounded-full px-3 py-1 text-sm ${filter === p.id
              ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
              : "border border-gray-300 dark:border-gray-700"
              }`}
          >
            {p.title}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {jobs.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No result jobs.</li>
        ) : (
          jobs.map((j) => {
            const applyNorm = normalizeApplyUrl(j.apply_url);
            const linkedins = parseStoredJsonStrings(j.linkedin_links);
            const contacts = parseStoredJsonStrings(j.hiring_contacts);
            return (
              <li key={j.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{j.company}</p>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{j.status}</span>
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300">{j.source_title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {prefTitle(j.preference_id)} · {j.discovered_at}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onChromeApply(j.id)}
                    className="text-sm text-blue-700 underline dark:text-blue-400"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => void onMarkApplied(j.id, applyNorm)}
                    className="text-sm text-green-700 underline dark:text-green-300"
                  >
                    Mark applied
                  </button>
                  <button
                    type="button"
                    onClick={() => void onArchive(j.id)}
                    className="text-sm text-gray-700 underline dark:text-gray-300"
                  >
                    Archive
                  </button>
                </div>
                <CliJobDetailSections
                  panel="results"
                  summary={j.summary}
                  compensationRange={j.compensation_range}
                  location={j.location}
                  companyHomepage={j.company_homepage}
                  sourceUrl={j.source_url}
                  listingText={j.listing_text}
                  discoveredAt={j.discovered_at}
                  linkedinLinks={linkedins}
                  hiringContacts={contacts}
                />
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function StatusesPanel(props: {
  bucket: "archived" | "applied";
  onBucket: (b: "archived" | "applied") => void;
  jobs: BucketJobRow[];
  onRestore: (jobId: string) => void;
  onDelete: (jobId: string) => void;
}) {
  const { bucket, onBucket, jobs, onRestore, onDelete } = props;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Statuses</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Archived and dismissed, or applied jobs.</p>
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

            return (
              <li key={j.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{j.company}</p>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{j.status}</span>
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

function ConfigPanel(props: {
  sqlite: JobmateSqlite | null;
  userId: string | null;
  profile: Record<string, unknown> | null;
  bumpData: () => void;
}) {
  const { sqlite, userId, profile, bumpData } = props;
  const [language, setLanguage] = useState<"en" | "fr">("en");
  const [serpApiKey, setSerpApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3-flash-preview");
  const [webhook, setWebhook] = useState("");
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

      if (cancelled) {
        return;
      }

      const lv = langRows[0]?.value;
      if (lv === "en" || lv === "fr") {
        setLanguage(lv);
      }

      setSerpApiKey(serp[0]?.value ?? "");
      setGeminiApiKey(gem[0]?.value ?? "");
      setGeminiModel(mod[0]?.value?.trim() ? String(mod[0].value) : "gemini-3-flash-preview");
      setWebhook(hook[0]?.value ?? "");
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId]);

  useEffect(() => {
    if (!profile) {
      return;
    }

    setFullName(String(profile.full_name ?? ""));
    setEmail(String(profile.email ?? ""));
    setWebsite(String(profile.website ?? ""));
    setCurrentLocation(String(profile.current_location ?? profile.location ?? ""));
    setPhone(String(profile.phone ?? ""));
    setLinkedinUrl(String(profile.linkedin_url ?? ""));
    setPreferredCompRange(String(profile.preferred_comp_range ?? ""));
    setCoverLetterTemplate(String(profile.cover_letter_template ?? ""));
    setWorkHistory(String(profile.work_history ?? ""));
    setSkills(String(profile.skills ?? ""));
    setEssay(String(profile.essay ?? ""));
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
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_LANGUAGE, language]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_SERPAPI_API_KEY,
        serpApiKey.trim()
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_GEMINI_API_KEY,
        geminiApiKey.trim()
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_GEMINI_MODEL,
        geminiModel.trim() || "gemini-3-flash-preview"
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_NOTIFICATION_WEBHOOK_URL,
        webhook.trim()
      ]);
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

      await sqlite.run(
        `UPDATE users SET email = ?, full_name = ?, location = ?, current_location = ?, phone = ?, linkedin_url = ?, preferred_comp_range = ?, cover_letter_template = ?, website = ?, work_history = ?, skills = ?, essay = ?, updated_at = ?
         WHERE id = ?`,
        [
          em,
          fn,
          loc,
          loc,
          phone.trim(),
          linkedinUrl.trim(),
          preferredCompRange.trim(),
          coverLetterTemplate.trim(),
          website.trim(),
          workHistory.trim(),
          skills.trim(),
          essay.trim(),
          now,
          userId
        ]
      );
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
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          One resume per profile, stored with your SQLite data in this browser. The PDF is attached for Gemini when generating application answers.
        </p>
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
        </div>
        <div>
          <label className={lb} htmlFor="cf-serp">
            SerpApi API key
          </label>
          <input id="cf-serp" className={fi} value={serpApiKey} onChange={(ev) => setSerpApiKey(ev.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className={lb} htmlFor="cf-gem">
            Gemini API key
          </label>
          <input id="cf-gem" className={fi} value={geminiApiKey} onChange={(ev) => setGeminiApiKey(ev.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className={lb} htmlFor="cf-mod">
            Gemini model
          </label>
          <input id="cf-mod" className={fi} value={geminiModel} onChange={(ev) => setGeminiModel(ev.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className={lb} htmlFor="cf-wh">
            Webhook URL (digest notifications)
          </label>
          <input id="cf-wh" className={fi} value={webhook} onChange={(ev) => setWebhook(ev.target.value)} autoComplete="off" />
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
        </div>
        <div>
          <label className={lb} htmlFor="cf-em">
            Email
          </label>
          <input id="cf-em" type="email" className={fi} value={email} onChange={(ev) => setEmail(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-site">
            Website
          </label>
          <input id="cf-site" className={fi} value={website} onChange={(ev) => setWebsite(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-loc">
            Location
          </label>
          <input id="cf-loc" className={fi} value={currentLocation} onChange={(ev) => setCurrentLocation(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-ph">
            Phone
          </label>
          <input id="cf-ph" className={fi} value={phone} onChange={(ev) => setPhone(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-li">
            LinkedIn URL
          </label>
          <input id="cf-li" className={fi} value={linkedinUrl} onChange={(ev) => setLinkedinUrl(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-comp">
            Preferred compensation range
          </label>
          <input id="cf-comp" className={fi} value={preferredCompRange} onChange={(ev) => setPreferredCompRange(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-cover">
            Cover letter template
          </label>
          <textarea id="cf-cover" rows={5} className={fi} value={coverLetterTemplate} onChange={(ev) => setCoverLetterTemplate(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-whist">
            Work history
          </label>
          <textarea id="cf-whist" rows={6} className={fi} value={workHistory} onChange={(ev) => setWorkHistory(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-sk">
            Skills
          </label>
          <textarea id="cf-sk" rows={3} className={fi} value={skills} onChange={(ev) => setSkills(ev.target.value)} />
        </div>
        <div>
          <label className={lb} htmlFor="cf-essay">
            Writing sample (essay)
          </label>
          <textarea id="cf-essay" rows={6} className={fi} value={essay} onChange={(ev) => setEssay(ev.target.value)} />
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
