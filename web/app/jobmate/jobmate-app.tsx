import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { normalizeApplyUrl } from "@/lib/apply-url";

import { interruptApplyTabViaExtension, openApplyTabViaExtension } from "./extension-open-tab";
import { runBrowserIngestion } from "./browser-ingest";
import { classifyJobEmailStatus } from "./gemini-field-answers";
import {
  SETTING_APPLY_EMAIL,
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL,
  SETTING_INITIAL_SETUP_COMPLETE,
  SETTING_LANGUAGE,
  SETTING_HOME_SORT_BY,
  SETTING_NOTIFICATION_WEBHOOK_URL
} from "./kv-keys";
import { PreferenceEditorModal } from "./preference-editor";
import { insertResumePdfAsset, setUserResumeAsset } from "./browser-resume-asset";
import type { JobmateSqlite } from "./sqlite-client";
import { BrowserProfileWizard, BrowserSetupWizard } from "./startup-wizard";
import { useJobmateSqlite } from "./sqlite-context";
import { fetchGoogleOrganicViaExtensionBatch } from "./extension-google-batch";
import { openBackgroundTabViaExtension } from "./extension-open-tab";
import { enrichJobLeadMetadata } from "../../../lib/services/job-enrichment";
import { loadExtensionConfigFromSqlite } from "./extension-config";
import { JOBMATE_EXTENSION_VERSION, pingExtensionVersion } from "./extension-version";
import { ContactsModal, JobResultCard, type ResultJobRow } from "./results-panel";
import { getStoredTheme, toggleTheme, type JobmateTheme } from "./theme";

type PageId = "home" | "config";
type HomeSortBy = "alpha" | "retrieved" | "listed";

function parseHomeSortBy(value: string): HomeSortBy {
  if (value === "alpha" || value === "retrieved" || value === "listed") {
    return value;
  }
  throw new Error(`Invalid home sort setting: ${value}`);
}

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
  const [theme, setTheme] = useState<JobmateTheme>("dark");

  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);

  const [prefs, setPrefs] = useState<{
    id: string;
    title: string;
    enabled: number;
    updated_at: string;
    locations: string;
    keyword_seed: string;
    board_domains: string;
  }[]>([]);

  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [bucketFilter, setBucketFilter] = useState<null | "applied" | "archived">(null);
  const [resultJobs, setResultJobs] = useState<ResultJobRow[]>([]);
  const [bucketJobs, setBucketJobs] = useState<BucketJobRow[]>([]);
  const [perTargetLimit, setPerTargetLimit] = useState(20);
  const [homeSortBy, setHomeSortBy] = useState<HomeSortBy>("listed");

  const [applySessions, setApplySessions] = useState<Array<{
    jobId: string;
    company: string;
    sourceTitle: string;
    applyUrl: string;
    tabId?: number | null;
    status: string;
    needsAttention: boolean;
    attentionMessage: string;
    attentionInstruction: string;
    kind: string;
  }>>([]);

  const [emailSyncBusy, setEmailSyncBusy] = useState(false);

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
    setTheme(getStoredTheme());
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
        requestId?: string;
        pageUrl?: string;
        pageTabId?: number | null;
        tabId?: number | null;
      };
      if (!data || data.source !== "jobmate-extension") {
        return;
      }
      if (data.type === "JOBMATE_APPLY_STARTED") {
        const tabId = typeof data.tabId === "number" ? data.tabId : null;
        setApplySessions(prev => prev.map(s =>
          s.applyUrl === data.applyUrl ? { ...s, status: "Applying…", tabId } : s
        ));
        return;
      }
      if (data.type === "JOBMATE_APPLY_CLOSED") {
        const closedTabId = typeof data.tabId === "number" ? data.tabId : null;
        const closedApplyUrl = typeof data.applyUrl === "string" && data.applyUrl.trim()
          ? normalizeApplyUrl(data.applyUrl.trim())
          : "";
        setApplySessions(prev =>
          prev.filter(s => {
            if (closedTabId !== null && (s.tabId ?? null) === closedTabId) {
              return false;
            }
            if (closedApplyUrl && s.applyUrl === closedApplyUrl) {
              return false;
            }
            return true;
          })
        );
        return;
      }
      if (data.type !== "JOBMATE_APPLY_ATTENTION") {
        return;
      }
      setApplySessions(prev => prev.map(s =>
        s.applyUrl === data.applyUrl
          ? {
            ...s,
            status: data.kind === "confirm" ? "Review ready" : "Needs attention",
            needsAttention: true,
            attentionMessage: data.message ?? "",
            attentionInstruction: data.instruction ?? "",
            kind: data.kind ?? "stuck"
          }
          : s
      ));
    }
    window.addEventListener("message", onExtensionMessage);
    return () => window.removeEventListener("message", onExtensionMessage);
  }, []);

  const [setupGateResolved, setSetupGateResolved] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [extensionVersionModal, setExtensionVersionModal] = useState<null | { installed: string }>(null);

  useEffect(() => {
    if (!setupGateResolved || !setupComplete) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const installed = await pingExtensionVersion();
        if (cancelled) return;
        if (installed !== JOBMATE_EXTENSION_VERSION) {
          setExtensionVersionModal({ installed });
        }
      } catch {
        if (!cancelled) setExtensionVersionModal({ installed: "" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setupGateResolved, setupComplete]);

  useEffect(() => {
    if (!sqlite || userId === null || !setupGateResolved || !setupComplete) {
      return;
    }
    const db: JobmateSqlite = sqlite;
    const uid: string = userId;

    async function onConfigRequest(ev: MessageEvent) {
      const data = ev.data as {
        source?: string;
        type?: string;
        requestId?: string;
      };
      if (!data || data.source !== "jobmate-extension" || data.type !== "JOBMATE_WEB_CONFIG_REQUEST") {
        return;
      }
      const requestId = data.requestId;
      if (!requestId) {
        return;
      }

      try {
        const config = await loadExtensionConfigFromSqlite(db, uid);
        window.postMessage(
          {
            source: "jobmate-web",
            type: "JOBMATE_WEB_CONFIG",
            requestId,
            ok: true,
            config
          },
          "*"
        );
      } catch (err) {
        window.postMessage(
          {
            source: "jobmate-web",
            type: "JOBMATE_WEB_CONFIG",
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          },
          "*"
        );
      }
    }

    window.addEventListener("message", onConfigRequest);
    window.postMessage({ source: "jobmate-web", type: "JOBMATE_WEB_APP_READY" }, "*");
    return () => window.removeEventListener("message", onConfigRequest);
  }, [sqlite, userId, setupGateResolved, setupComplete]);

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

  useEffect(() => {
    if (!sqlite || userId === null || !setupGateResolved || !setupComplete) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const rows = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_HOME_SORT_BY]
        );

        if (cancelled) {
          return;
        }

        if (rows.length > 0) {
          setHomeSortBy(parseHomeSortBy(rows[0].value));
        } else {
          await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
            SETTING_HOME_SORT_BY,
            "listed"
          ]);
        }
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId, setupGateResolved, setupComplete]);

  const saveHomeSortBy = useCallback(
    async (nextSortBy: HomeSortBy) => {
      if (!sqlite || userId === null) {
        throw new Error("Cannot save sort setting before the database and user are ready.");
      }
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_HOME_SORT_BY,
        nextSortBy
      ]);
      setHomeSortBy(nextSortBy);
    },
    [sqlite, userId]
  );

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
      if (page === "home") {
        const prows = await sqlite.all<{
          id: string;
          title: string;
          enabled: number;
          updated_at: string;
          locations: string;
          keyword_seed: string;
          board_domains: string;
        }>(
          "SELECT id, title, enabled, updated_at, locations, keyword_seed, board_domains FROM preferences WHERE user_id = ? ORDER BY datetime(updated_at) DESC",
          [userId]
        );
        setPrefs(prows);

        const jrows = await sqlite.all<ResultJobRow>(
          `SELECT id, preference_id, company, source_title, status, discovered_at, posted_at, company_logo_url, apply_url,
            source_url, summary, listing_text, compensation_range, location, company_homepage,
            linkedin_links, hiring_contacts
           FROM jobs WHERE user_id = ? AND status IN ('new', 'reviewed') ORDER BY datetime(discovered_at) DESC`,
          [userId]
        );
        setResultJobs(jrows);
      } else if (page === "config") {
        const [u] = await sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId]);
        setProfile(u ?? null);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!hideMainLoading) {
        setBusy(false);
      }
    }
  }, [sqlite, userId, page, dataEpoch]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const loadBucketJobs = useCallback(
    async (bucket: "applied" | "archived") => {
      if (!sqlite || userId === null) {
        return;
      }

      const statuses =
        bucket === "applied"
          ? (["applied"] as const)
          : (["archived", "dismissed"] as const);
      const placeholders = statuses.map(() => "?").join(", ");
      const jrows = await sqlite.all<BucketJobRow>(
        `SELECT id, company, source_title, status, discovered_at, applied_at, archived_at, apply_url,
          source_url, summary, listing_text, compensation_range, location, company_homepage,
          linkedin_links, hiring_contacts, applied_application_url, applied_at_linkedin_links, applied_at_hiring_contacts, email_status
         FROM jobs WHERE user_id = ? AND status IN (${placeholders}) ORDER BY datetime(COALESCE(applied_at, archived_at, discovered_at)) DESC`,
        [userId, ...statuses]
      );
      setBucketJobs(jrows);
    },
    [sqlite, userId, dataEpoch]
  );

  const toggleTargetSelection = useCallback((prefId: string) => {
    setBucketFilter(null);
    setSelectedTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(prefId)) next.delete(prefId);
      else next.add(prefId);
      return next;
    });
  }, []);

  const selectBucket = useCallback((bucket: "applied" | "archived") => {
    setSelectedTargetIds(new Set());
    setBucketFilter(bucket);
    void loadBucketJobs(bucket);
  }, [loadBucketJobs]);

  const runSearchPipeline = useCallback(async (prefIds: Set<string>) => {
    if (!sqlite || userId === null) {
      return;
    }

    if (ingestRunningRef.current) {
      toast.warning("Search pipeline already running");
      return;
    }

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
        geminiApiKey: gemRows[0]?.value?.trim() ? gemRows[0].value : null,
        geminiModel: modRows[0]?.value?.trim() || "gemini-3.1-flash-lite",
        webhookUrl: hookRows[0]?.value?.trim() ?? "",
        perTargetLimit,
        preferenceIds: Array.from(prefIds),
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
  }, [sqlite, userId, bumpData, perTargetLimit]);

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
    await sqlite.run(`UPDATE preferences SET enabled = ? WHERE id = ? AND user_id = ?`, [
      enabled ? 1 : 0,
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
    if (!row) {
      throw new Error(`Cannot mark missing job as applied: ${jobId}`);
    }
    const now = new Date().toISOString();
    const contacts = row.hiring_contacts;
    const links = row.linkedin_links;
    if (contacts === null || links === null) {
      throw new Error(`Cannot snapshot empty contact fields for job: ${jobId}`);
    }
    await sqlite.run(
      `UPDATE jobs SET status = ?, applied_at = ?, applied_application_url = ?, applied_at_hiring_contacts = ?, applied_at_linkedin_links = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ["applied", now, applyUrl, contacts, links, now, jobId, userId]
    );
    setResultJobs((prev) => prev.filter((job) => job.id !== jobId));
    if (bucketFilter === "applied") {
      void loadBucketJobs("applied");
    }
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

      if (applySessions.some(s => s.jobId === jobId)) {
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
      if (!job) return;

      let linkedinLinks: string[] = [];
      try { linkedinLinks = JSON.parse(String(job.linkedin_links ?? "[]")) as string[]; } catch { linkedinLinks = []; }

      let hiringContacts: string[] = [];
      try { hiringContacts = JSON.parse(String(job.hiring_contacts ?? "[]")) as string[]; } catch { hiringContacts = []; }

      const sessionId = crypto.randomUUID();
      const applyUrlNormalized = normalizeApplyUrl(String(job.apply_url));

      const newSession = {
        jobId,
        company: String(job.company),
        sourceTitle: String(job.source_title),
        applyUrl: applyUrlNormalized,
        status: "Opening apply tab…",
        needsAttention: false,
        attentionMessage: "",
        attentionInstruction: "",
        kind: ""
      };

      setApplySessions(prev => [...prev, newSession]);

      try {
        const { tabId } = await openApplyTabViaExtension(applyUrlNormalized, sessionId, {
          jobId,
          title: String(job.source_title ?? ""),
          company: String(job.company ?? ""),
          companyHomepage: String(job.company_homepage ?? ""),
          listingText: String(job.listing_text ?? ""),
          linkedinLinks: Array.isArray(linkedinLinks) ? linkedinLinks.map(String) : [],
          hiringContacts: Array.isArray(hiringContacts) ? hiringContacts.map(String) : []
        });
        setApplySessions(prev =>
          prev.map(s =>
            s.jobId === jobId ? { ...s, status: "Applying…", tabId: typeof tabId === "number" ? tabId : s.tabId } : s
          )
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setApplySessions(prev => prev.filter(s => s.jobId !== jobId));
        return;
      }
    },
    [sqlite, userId, applySessions]
  );

  async function deleteJobRow(jobId: string) {
    if (!sqlite || userId === null) {
      return;
    }
    await sqlite.run(`DELETE FROM jobs WHERE id = ? AND user_id = ?`, [jobId, userId]);
    bumpData();
  }

  async function doneApplying(jobId: string, applyUrl: string) {
    if (!sqlite || !userId) {
      return;
    }
    try {
      await markAppliedRow(jobId, applyUrl);
      setApplySessions(prev => prev.filter(s => s.jobId !== jobId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function archiveFromApplySession(jobId: string) {
    await archiveJobRow(jobId);
    setApplySessions(prev => prev.filter(s => s.jobId !== jobId));
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

    const fetchOrganic = async (query: string, limit: number) => {
      const batch = await fetchGoogleOrganicViaExtensionBatch([query], limit);
      return batch.get(query) ?? [];
    };

    const leadMetadata = await enrichJobLeadMetadata({
      company: job.company,
      listingText: job.listing_text,
      sourceUrl: job.source_url,
      parsedHomepage: job.company_homepage,
      parsedLinkedinLinks: [],
      fetchOrganic
    });

    const linkedinLinks = leadMetadata.linkedinLinks;
    const hiringContacts = leadMetadata.hiringContacts;
    const companyHomepage = leadMetadata.companyHomepage ?? job.company_homepage;
    const now = new Date().toISOString();

    await sqlite.run(
      `UPDATE jobs SET linkedin_links = ?, hiring_contacts = ?, company_homepage = COALESCE(?, company_homepage), updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(linkedinLinks), JSON.stringify(hiringContacts), companyHomepage, now, job.id, userId]
    );
    bumpData();

    return { linkedinLinks, hiringContacts };
  }

  const filteredResults = useMemo(() => {
    if (bucketFilter) {
      return [];
    }
    const list =
      selectedTargetIds.size === 0 ? resultJobs : resultJobs.filter((j) => selectedTargetIds.has(j.preference_id));
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
  }, [resultJobs, selectedTargetIds, bucketFilter]);

  if (error) {
    return (
      <div className="jm-page-bg min-h-screen px-6 py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="jm-page-bg min-h-screen px-6 py-8">
        <p className="text-sm text-gray-500 dark:text-gray-400">Gathering data…</p>
      </div>
    );
  }

  if (userBootstrap === "pending") {
    return (
      <div className="jm-page-bg min-h-screen px-6 py-8">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      </div>
    );
  }

  if (userId === null) {
    if (fetchError) {
      return (
        <div className="jm-page-bg min-h-screen px-6 py-8">
          <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>
        </div>
      );
    }

    if (!sqlite) {
      return (
        <div className="jm-page-bg min-h-screen px-6 py-8">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      );
    }

    return <BrowserProfileWizard sqlite={sqlite} onCreatedUserId={setUserId} />;
  }

  if (!setupGateResolved) {
    return (
      <div className="jm-page-bg min-h-screen px-6 py-8">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      </div>
    );
  }

  if (!setupComplete) {
    if (!sqlite) {
      return (
        <div className="jm-page-bg min-h-screen px-6 py-8">
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
    <div className="jm-app relative flex h-dvh min-h-0 flex-col">
      <header className="jm-header shrink-0 z-30">
        <button
          type="button"
          onClick={() => setPage("home")}
          className="jm-header-title text-lg border-none bg-transparent p-0 cursor-pointer"
        >
          JOB<span>MATE</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage("config")}
            className={`jm-theme-toggle ${page === "config" ? "jm-tab-active" : ""}`}
          >
            ⚙️ Settings
          </button>
          <button
            type="button"
            className="jm-theme-toggle"
            onClick={() => setTheme((current) => toggleTheme(current))}
          >
            {theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode"}
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {applySessions.map((s, i) => (
        <ApplySessionBadge
          key={s.jobId}
          session={s}
          index={i}
          onDismiss={() => setApplySessions(prev => prev.filter(x => x.jobId !== s.jobId))}
          onDoneApplying={() => void doneApplying(s.jobId, s.applyUrl)}
          onArchive={() => void archiveFromApplySession(s.jobId)}
          onInterrupt={() => {
            const tabId = typeof s.tabId === "number" ? s.tabId : null;
            if (tabId === null) {
              toast.error("Could not find the active apply tab.");
              return;
            }
            void interruptApplyTabViaExtension(tabId).catch((err) => {
              toast.error(err instanceof Error ? err.message : String(err));
            });
          }}
        />
      ))}
      {extensionVersionModal ? (
        <ExtensionVersionModal
          installed={extensionVersionModal.installed}
          expected={JOBMATE_EXTENSION_VERSION}
          onDismiss={() => setExtensionVersionModal(null)}
        />
      ) : null}
      <main
        className={`flex min-h-0 w-full flex-1 flex-col px-8 ${page === "home" ? "overflow-hidden pt-10 pb-0" : "overflow-auto py-10"}`}
      >
        {fetchError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>
        ) : busy ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : page === "home" ? (
          <HomePanel
            prefs={prefs}
            resultJobs={filteredResults}
            bucketJobs={bucketJobs}
            sortBy={homeSortBy}
            onSortByChange={saveHomeSortBy}
            selectedTargetIds={selectedTargetIds}
            bucketFilter={bucketFilter}
            onToggleTarget={toggleTargetSelection}
            onSelectBucket={selectBucket}
            perTargetLimit={perTargetLimit}
            onPerTargetLimitChange={setPerTargetLimit}
            ingestRunning={ingestRunning}
            onRunSearch={() => void runSearchPipeline(selectedTargetIds)}
            onAdd={() => setPrefModal({ mode: "add", row: null })}
            onEdit={async (id) => {
              const row = await loadPreferenceRow(id);
              if (row) { setPrefModal({ mode: "edit", row }); }
            }}
            onDelete={deletePreference}
            confirmClearHistory={confirmClearHistory}
            setConfirmClearHistory={setConfirmClearHistory}
            onClearHistory={clearJobHistory}
            onArchive={archiveJobRow}
            onMarkApplied={markAppliedRow}
            onChromeApply={openChromeApplyForJob}
            onFetchContacts={fetchJobContacts}
            onRestoreJob={(id) => void (bucketFilter === "applied" ? unapplyRow(id) : unarchiveRow(id))}
            onDeleteJob={deleteJobRow}
            emailSyncBusy={emailSyncBusy}
            onEmailSync={() => void runEmailSync()}
          />
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
    </div>
  );
}

function ExtensionVersionModal(props: { installed: string; expected: string; onDismiss: () => void }) {
  const { installed, expected, onDismiss } = props;
  const missing = !installed.trim();

  return (
    <div className="jm-overlay fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="jm-panel w-full max-w-md p-6"
      >
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {missing ? "Chrome extension required" : "Chrome extension update required"}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {missing
            ? "JobMate needs the Chrome extension loaded to search and apply in your browser."
            : `Your extension reports version ${installed}. This app requires version ${expected}.`}
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-gray-700 dark:text-gray-300">
          <li>
            <a href="/chrome-extension.zip" download className="font-medium text-blue-700 underline dark:text-blue-400">
              Download chrome-extension.zip
            </a>
          </li>
          <li>Open <span className="font-mono text-xs">chrome://extensions</span> in Chrome.</li>
          <li>Enable Developer mode.</li>
          <li>Remove the old JobMate extension if it is listed.</li>
          <li>Extract the zip, then choose Load unpacked and select the extracted folder.</li>
          <li>Reload this page.</li>
        </ol>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-6 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Dismiss
        </button>
      </div>
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
  index: number;
  onDismiss: () => void;
  onDoneApplying: () => void;
  onArchive: () => void;
  onInterrupt: () => void;
}) {
  const { session, index, onDismiss, onDoneApplying, onArchive, onInterrupt } = props;
  const isAttention = session.needsAttention;
  const topOffset = 16 + index * 220;

  return (
    <div className="jm-panel fixed right-4 z-50 w-72 overflow-hidden shadow-lg" style={{ top: topOffset }}>
      <div
        className="flex items-center justify-between border-b px-4 py-2"
        style={{
          borderColor: "var(--color-border)",
          backgroundColor: isAttention ? "var(--color-bg-head)" : "var(--color-bg-side)"
        }}
      >
        <span className="jm-section-title text-xs">
          {isAttention ? "⚠ Apply" : "▶ Apply"}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="jm-muted text-xs hover:opacity-80"
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
        <div className="px-4 pb-3 space-y-2">
          <button
            type="button"
            onClick={onInterrupt}
            className="jm-btn-ghost w-full px-3 py-2 text-sm"
          >
            Interrupt
          </button>
          <button
            type="button"
            onClick={onDoneApplying}
            className="jm-btn-primary w-full px-3 py-2 text-sm"
          >
            Done applying
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Archive
          </button>
        </div>
      ) : (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={onInterrupt}
            className="jm-btn-ghost w-full px-3 py-2 text-sm"
          >
            Interrupt
          </button>
        </div>
      )}
    </div>
  );
}

function HomePanel(props: {
  prefs: {
    id: string;
    title: string;
    enabled: number;
    updated_at: string;
    locations: string;
    keyword_seed: string;
    board_domains: string;
  }[];
  resultJobs: ResultJobRow[];
  bucketJobs: BucketJobRow[];
  sortBy: HomeSortBy;
  onSortByChange: (sortBy: HomeSortBy) => Promise<void>;
  selectedTargetIds: Set<string>;
  bucketFilter: null | "applied" | "archived";
  onToggleTarget: (id: string) => void;
  onSelectBucket: (bucket: "applied" | "archived") => void;
  perTargetLimit: number;
  onPerTargetLimitChange: (v: number) => void;
  ingestRunning: boolean;
  onRunSearch: () => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  confirmClearHistory: boolean;
  setConfirmClearHistory: (v: boolean) => void;
  onClearHistory: () => void;
  onArchive: (jobId: string) => void | Promise<void>;
  onMarkApplied: (jobId: string, applyUrl: string) => void | Promise<void>;
  onChromeApply: (jobId: string) => void | Promise<void>;
  onFetchContacts: (job: ResultJobRow) => Promise<{ linkedinLinks: string[]; hiringContacts: string[] }>;
  onRestoreJob: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
  emailSyncBusy: boolean;
  onEmailSync: () => void;
}) {
  const {
    prefs, resultJobs, bucketJobs, sortBy, onSortByChange, selectedTargetIds, bucketFilter, onToggleTarget, onSelectBucket,
    perTargetLimit, onPerTargetLimitChange,
    ingestRunning, onRunSearch, onAdd, onEdit, onDelete,
    confirmClearHistory, setConfirmClearHistory, onClearHistory,
    onArchive, onMarkApplied, onChromeApply, onFetchContacts,
    onRestoreJob, onDeleteJob, emailSyncBusy, onEmailSync
  } = props;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [contactsJob, setContactsJob] = useState<ResultJobRow | null>(null);
  const [contactsLinkedin, setContactsLinkedin] = useState<string[]>([]);
  const [contactsEmails, setContactsEmails] = useState<string[]>([]);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);

  const isBucket = bucketFilter !== null;
  const visibleResultJobs = isBucket ? [] : (selectedTargetIds.size === 0 ? resultJobs : resultJobs.filter((j) => selectedTargetIds.has(j.preference_id)));
  const allSelected = visibleResultJobs.length > 0 && visibleResultJobs.every((j) => selected.has(j.id));

  function toggleOne(jobId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) { next.delete(jobId); } else { next.add(jobId); }
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) { setSelected(new Set()); return; }
    setSelected(new Set(visibleResultJobs.map((j) => j.id)));
  }

  async function runBulk(action: "apply" | "mark" | "archive") {
    const ids = Array.from(selected);
    for (const id of ids) {
      const job = visibleResultJobs.find((j) => j.id === id);
      if (!job) continue;
      if (action === "apply") await onChromeApply(job.id);
      else if (action === "mark") await markJobApplied(job);
      else await onArchive(job.id);
    }
    setSelected(new Set());
  }

  async function markJobApplied(job: ResultJobRow) {
    try {
      await onMarkApplied(job.id, normalizeApplyUrl(job.apply_url));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function openContacts(job: ResultJobRow) {
    const storedLinkedin = parseStoredJsonStrings(job.linkedin_links);
    const storedContacts = parseStoredJsonStrings(job.hiring_contacts);
    setContactsJob(job);
    setContactsLinkedin(storedLinkedin);
    setContactsEmails(storedContacts);
    setContactsError(null);
    if (storedLinkedin.length || storedContacts.length) return;
    setContactsBusy(true);
    try {
      const fetched = await onFetchContacts(job);
      setContactsLinkedin(fetched.linkedinLinks);
      setContactsEmails(fetched.hiringContacts);
    } catch (e) {
      setContactsError(e instanceof Error ? e.message : String(e));
    } finally {
      setContactsBusy(false);
    }
  }

  async function changeSort(value: string) {
    try {
      await onSortByChange(parseHomeSortBy(value));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const enabledTargetsCount = selectedTargetIds.size;
  const runDisabled = ingestRunning || enabledTargetsCount === 0;
  const sortedVisibleResultJobs = useMemo(() => {
    const list = [...visibleResultJobs];
    if (sortBy === "alpha") {
      list.sort((a, b) => `${a.company} ${a.source_title}`.localeCompare(`${b.company} ${b.source_title}`));
      return list;
    }
    if (sortBy === "listed") {
      list.sort((a, b) => {
        const av = a.posted_at ? Date.parse(a.posted_at) : Number.NEGATIVE_INFINITY;
        const bv = b.posted_at ? Date.parse(b.posted_at) : Number.NEGATIVE_INFINITY;
        return bv - av;
      });
      return list;
    }
    list.sort((a, b) => Date.parse(b.discovered_at) - Date.parse(a.discovered_at));
    return list;
  }, [visibleResultJobs, sortBy]);
  const sortedBucketJobs = useMemo(() => {
    const list = [...bucketJobs];
    if (sortBy === "alpha") {
      list.sort((a, b) => `${a.company} ${a.source_title}`.localeCompare(`${b.company} ${b.source_title}`));
      return list;
    }
    if (sortBy === "listed") {
      list.sort((a, b) => {
        const av = Date.parse(a.applied_at ?? a.archived_at ?? a.discovered_at);
        const bv = Date.parse(b.applied_at ?? b.archived_at ?? b.discovered_at);
        return bv - av;
      });
      return list;
    }
    list.sort((a, b) => Date.parse(b.discovered_at) - Date.parse(a.discovered_at));
    return list;
  }, [bucketJobs, sortBy]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h2 className="jm-header-title text-xl">Home</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <span className="text-xs text-gray-500 dark:text-gray-400">Jobs per target</span>
            <input
              type="number"
              min={1}
              max={500}
              value={perTargetLimit}
              onChange={(ev) => onPerTargetLimitChange(Math.max(1, parseInt(ev.target.value, 10) || 1))}
              className="jm-input w-20 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <button
            type="button"
            disabled={runDisabled}
            onClick={() => void onRunSearch()}
            className="jm-btn-primary px-4 py-2 disabled:opacity-50"
          >
            {ingestRunning ? "Running…" : `Run ${enabledTargetsCount} target${enabledTargetsCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      <section className="shrink-0 space-y-3">
        <button
          type="button"
          onClick={() => setTargetsOpen((open) => !open)}
          className="jm-targets-toggle"
          aria-expanded={targetsOpen}
        >
          <span
            className={`jm-targets-chevron ${targetsOpen ? "jm-targets-chevron-open" : ""}`}
            aria-hidden
          >
            ▶
          </span>
          Targets
          <span className="jm-muted text-xs font-normal">
            {selectedTargetIds.size} selected
          </span>
        </button>
        <div className={`jm-targets-panel ${targetsOpen ? "jm-targets-panel-open" : ""}`}>
          <div className="jm-targets-panel-inner">
            <div className="jm-targets-container">
              <div className="flex gap-3 overflow-x-auto pb-1">
            {prefs.length === 0 ? (
              <div className="jm-muted w-full px-4 py-6 text-center text-sm">
                No targets yet. Add one to get started.
              </div>
            ) : (
              prefs.map((p) => (
                <div
                  key={p.id}
                  onClick={() => onToggleTarget(p.id)}
                  className={`jm-card flex h-full w-64 shrink-0 cursor-pointer flex-col p-4 transition-colors ${selectedTargetIds.has(p.id) ? "jm-selected" : ""
                    }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 text-left">
                      <p className={`text-sm font-semibold wrap-break-word ${selectedTargetIds.has(p.id) ? "text-gray-900 dark:text-gray-100" : "text-gray-800 dark:text-gray-200"}`}>
                        {p.title}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                    <p className="wrap-break-word">
                      Keywords: {parseStoredJsonStrings(p.keyword_seed).join(", ") || "—"}
                    </p>
                    <p className="wrap-break-word">
                      Locations: {parseStoredJsonStrings(p.locations).join(", ") || "—"}
                    </p>
                    <p className="wrap-break-word">
                      Site targets: {parseStoredJsonStrings(p.board_domains).join(", ") || "—"}
                    </p>
                  </div>
                  <div className="mt-auto pt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void onEdit(p.id);
                      }}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900/60"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void onDelete(p.id);
                      }}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {!isBucket ? (
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Select all
              </label>
            ) : null}
            {!isBucket && selected.size > 0 ? (
              <>
                <span className="text-sm text-gray-500 dark:text-gray-400">{selected.size} selected</span>
                <button
                  type="button"
                  onClick={() => void runBulk("apply")}
                  className="jm-btn-primary px-3 py-1.5"
                >
                  Mass apply
                </button>
                <button
                  type="button"
                  onClick={() => void runBulk("mark")}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
                >
                  Mass mark applied
                </button>
                <button
                  type="button"
                  onClick={() => void runBulk("archive")}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
                >
                  Mass archive
                </button>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectBucket("applied")}
              className={`text-xs ${bucketFilter === "applied" ? "jm-tab jm-tab-active" : "jm-tab"}`}
            >
              Applied Jobs
            </button>
            <button
              type="button"
              onClick={() => onSelectBucket("archived")}
              className={`text-xs ${bucketFilter === "archived" ? "jm-tab jm-tab-active" : "jm-tab"}`}
            >
              Archived Jobs
            </button>
            <button
              type="button"
              onClick={onAdd}
              className="jm-btn-ghost text-xs"
            >
              New target
            </button>
            {confirmClearHistory ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmClearHistory(false)}
                  className="jm-btn-ghost text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onClearHistory()}
                  className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-400"
                >
                  Confirm clear history
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClearHistory(true)}
                className="jm-btn-ghost text-xs"
              >
                Clear history
              </button>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <span>Sort</span>
              <select
                value={sortBy}
                onChange={(ev) => void changeSort(ev.target.value)}
                className="jm-input px-2 py-1 text-sm"
              >
                <option value="alpha">Alphabetical</option>
                <option value="retrieved">Date retrieved</option>
                <option value="listed">Date listed</option>
              </select>
            </label>
          </div>
        </div>
        <div
          className="flex min-h-0 flex-1 overflow-hidden rounded-xl border"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-side)" }}
        >
          {isBucket ? (
            <div className="flex min-h-0 h-full w-full flex-col">
              {bucketFilter === "applied" ? (
                <div className="shrink-0 flex justify-end p-3 border-b border-gray-200 dark:border-gray-800">
                  <button
                    type="button"
                    onClick={onEmailSync}
                    disabled={emailSyncBusy}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-gray-600"
                  >
                    {emailSyncBusy ? "Syncing…" : "Email sync"}
                  </button>
                </div>
              ) : null}
              <ul className="min-h-0 h-full w-full divide-y divide-gray-200 overflow-y-auto dark:divide-gray-800">
                {sortedBucketJobs.length === 0 ? (
                  <li className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No jobs in this bucket.</li>
                ) : (
                  sortedBucketJobs.map((j) => {
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
                          <button type="button" onClick={() => void onRestoreJob(j.id)} className="jm-link text-sm">
                            {bucketFilter === "archived" ? "Unarchive" : "Unapply"}
                          </button>
                          <button type="button" onClick={() => void onDeleteJob(j.id)} className="text-sm text-red-700 underline dark:text-red-400">
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
                          appliedApplicationUrl={bucketFilter === "applied" ? applicationUrl : null}
                          appliedLinkedinSnapshot={snapLi}
                          appliedContactsSnapshot={snapCt}
                        />
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          ) : (
            <>
              {sortedVisibleResultJobs.length === 0 ? (
                <div className="p-4">
                  <p className="text-sm text-gray-500 dark:text-gray-400">No result jobs.</p>
                </div>
              ) : (
                <div className="min-h-0 h-full w-full overflow-auto">
                  <div className="grid w-full gap-3 p-1 [grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr))]">
                    {sortedVisibleResultJobs.map((j) => (
                      <JobResultCard
                        key={j.id}
                        job={j}
                        selected={selected.has(j.id)}
                        onToggleSelect={() => toggleOne(j.id)}
                        onApply={() => void onChromeApply(j.id)}
                        onViewListing={() => void openBackgroundTabViaExtension(j.source_url)}
                        onMarkApplied={() => void markJobApplied(j)}
                        onArchive={() => void onArchive(j.id)}
                        onViewContacts={() => void openContacts(j)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {contactsJob ? (
        <ContactsModal
          job={contactsJob}
          linkedinLinks={contactsLinkedin}
          hiringContacts={contactsEmails}
          busy={contactsBusy}
          error={contactsError}
          onClose={() => { setContactsJob(null); setContactsError(null); }}
        />
      ) : null}
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
      const nextGem = gem[0]?.value ?? "";
      const nextModel = mod[0]?.value?.trim() ? String(mod[0].value) : "gemini-3.1-flash-lite";
      const nextWebhook = hook[0]?.value ?? "";
      const nextApplyEmail = apply[0]?.value ?? "";

      setLanguage(nextLanguage);
      setGeminiApiKey(nextGem);
      setGeminiModel(nextModel);
      setWebhook(nextWebhook);
      setApplyEmail(nextApplyEmail);
      setSavedLanguage(nextLanguage);
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
      const nextGem = geminiApiKey.trim();
      const nextModel = geminiModel.trim() || "gemini-3.1-flash-lite";
      const nextWebhook = webhook.trim();
      const nextApplyEmail = applyEmail.trim();

      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_LANGUAGE, nextLanguage]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_GEMINI_API_KEY, nextGem]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_GEMINI_MODEL, nextModel]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_NOTIFICATION_WEBHOOK_URL,
        nextWebhook
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [SETTING_APPLY_EMAIL, nextApplyEmail]);

      setSavedLanguage(nextLanguage);
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

  const fi = "jm-input mt-1 w-full px-3 py-2 text-sm";
  const lb = "block text-sm font-medium";
  const st = "jm-muted mt-1 text-xs";

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Config</h2>
        <p className="jm-muted mt-1 text-sm">API keys, profile, and Chrome extension download.</p>
      </div>

      <section className="jm-panel rounded-xl p-4">
        <h3 className="text-sm font-semibold">Chrome extension</h3>
        <p className="jm-muted mt-2 text-sm">
          Download the unpacked extension, then in Chrome open chrome://extensions, enable Developer mode, choose Load unpacked,
          and extract the zip.
        </p>
        <a
          href="/chrome-extension.zip"
          download
          className="jm-link mt-3 inline-block text-sm font-medium"
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
          className="jm-btn-primary px-4 py-2 disabled:opacity-50"
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
          className="jm-btn-primary px-4 py-2 disabled:opacity-50"
        >
          Save profile
        </button>
      </section>

      {cfgMsg ? <p className="text-sm text-gray-600 dark:text-gray-400">{cfgMsg}</p> : null}
    </div>
  );
}
