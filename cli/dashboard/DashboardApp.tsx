import { CancelPromptError, ExitPromptError } from "@inquirer/core";
import { confirm } from "@inquirer/prompts";
import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useAnimation, useInput, useWindowSize } from "ink";

import { normalizeApplyUrl } from "@/lib/apply-url";
import {
  clearJobHistoryForUser,
  archiveJob,
  deleteJob,
  deletePreference,
  getPreferenceMap,
  getUserProfile,
  listDailyMetrics,
  listJobsByStatus,
  listJobsForResults,
  listJobsNotApplied,
  markJobApplied,
  listPreferencesMaps,
  setPreferenceEnabled,
  unapplyJob,
  unarchiveJob
} from "@/lib/data";
import { openFollowUpEmails } from "@/lib/follow-up";
import { openUrlInDefaultBrowser } from "@/lib/open-external";
import { runIngestion, type IngestionProgress } from "@/lib/services/ingest";
import { runApplyJobChromeExtension } from "@/lib/chrome-extension/apply-job";

import { insertPreferenceFromPrompts, updatePreferenceFromPrompts } from "../preference-prompts";
import {
  runApiSettings,
  runChromeExtensionSettings,
  runEssaySettings,
  runLanguageSettings,
  runProfileSettings,
  runResumeSettings
} from "../settings-menu";
import { getEnv, getFilesDir } from "@/lib/env";
import { getAppLanguage, translate } from "@/lib/i18n";
import { prepareStdinBeforeExternalPrompts } from "../prepare-stdin-prompts";
import { reportError } from "../report-error";
import { t } from "./theme";

function isPromptDismissal(err: unknown) {
  return (
    err instanceof ExitPromptError ||
    err instanceof CancelPromptError ||
    (err instanceof Error && (err.name === "ExitPromptError" || err.name === "CancelPromptError"))
  );
}

export type DashboardAppProps = {
  userId: string;
  onExit: () => void;
};

type PageId = "home" | "targets" | "results" | "statuses" | "metrics" | "config";

const PAGE_ORDER: PageId[] = ["home", "targets", "results", "statuses", "metrics", "config"];

function truncate(s: string, max: number) {
  const x = s.replace(/\s+/g, " ").trim();

  if (x.length <= max) {
    return x;
  }

  return `${x.slice(0, Math.max(0, max - 1))}…`;
}

function compactDetail(value: unknown) {
  return truncate(String(value ?? "Not found"), 100);
}

function formatLocalDateTime(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function daysAgo(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.max(0, Math.floor((startToday - startDate) / 86_400_000));

  if (days === 0) {
    return "today";
  }

  if (days === 1) {
    return "1 day ago";
  }

  return `${days} days ago`;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function DashboardApp({ userId, onExit }: DashboardAppProps) {
  const language = getAppLanguage();
  const { columns, rows } = useWindowSize();
  const [page, setPage] = useState<PageId>("home");
  const [pane, setPane] = useState<"sidebar" | "main">("sidebar");
  const [targetIdx, setTargetIdx] = useState(0);
  const [resultTargetIdx, setResultTargetIdx] = useState(0);
  const [jobIdx, setJobIdx] = useState(0);
  const [statusBucket, setStatusBucket] = useState<"archived" | "applied">("archived");
  const [statusIdx, setStatusIdx] = useState(0);
  const [cfgSel, setCfgSel] = useState(0);
  const [inputActive, setInputActive] = useState(true);
  const [dataEpoch, setDataEpoch] = useState(0);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [searchRunning, setSearchRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const suspendForExternal = useCallback(async (run: () => Promise<void>) => {
    setInputActive(false);
    setActionError(null);
    await new Promise<void>((r) => setTimeout(r, 0));

    try {
      prepareStdinBeforeExternalPrompts();
      await run();
    } catch (err) {
      if (!isPromptDismissal(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionError(msg);
        reportError("Action failed (external prompts)", err);
      }
    } finally {
      setBusyMessage(null);
      setDataEpoch((x) => x + 1);
      setInputActive(true);
    }
  }, []);

  const profile = useMemo(() => getUserProfile(userId), [userId, dataEpoch]);
  const prefs = useMemo(() => listPreferencesMaps(userId), [userId, dataEpoch]);
  const jobs = useMemo(() => listJobsForResults(userId), [userId, dataEpoch]);
  const appliedJobs = useMemo(() => listJobsByStatus(userId, ["applied"]), [userId, dataEpoch]);
  const archivedJobs = useMemo(() => listJobsByStatus(userId, ["archived", "dismissed"]), [userId, dataEpoch]);
  const metrics = useMemo(() => listDailyMetrics(userId), [userId, dataEpoch]);

  const jobsByPreference = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();

    for (const pref of prefs) {
      map.set(String(pref._id), []);
    }

    for (const job of jobs) {
      const key = String(job.preferenceId);
      map.set(key, [...(map.get(key) ?? []), job]);
    }

    return map;
  }, [prefs, jobs]);

  const mainW = Math.max(40, columns - 24);
  const listMax = Math.max(3, rows - 14);

  function goPage(next: PageId) {
    setPage(next);
    setPane("sidebar");

    if (next === "targets") {
      setTargetIdx(0);
    }

    if (next === "results") {
      setResultTargetIdx(0);
      setJobIdx(0);
    }

    if (next === "statuses") {
      setStatusIdx(0);
    }

    if (next === "config") {
      setCfgSel(0);
    }
  }

  function sidebarStep(delta: number) {
    const i = PAGE_ORDER.indexOf(page);
    const n = Math.max(0, Math.min(PAGE_ORDER.length - 1, i + delta));
    goPage(PAGE_ORDER[n]);
  }

  function enterMainPanel() {
    if (page === "home") {
      return;
    }

    setPane("main");

    if (page === "targets") {
      setTargetIdx((i) => Math.min(Math.max(i, 0), Math.max(prefs.length - 1, 0)));
    }

    if (page === "results") {
      setResultTargetIdx((i) => Math.min(Math.max(i, 0), Math.max(prefs.length - 1, 0)));
      const selectedPref = prefs[Math.min(resultTargetIdx, Math.max(prefs.length - 1, 0))];
      const selectedJobs = selectedPref ? jobsByPreference.get(String(selectedPref._id)) ?? [] : [];
      setJobIdx((i) => Math.min(Math.max(i, 0), Math.max(selectedJobs.length - 1, 0)));
    }

    if (page === "statuses") {
      const bucketJobs = statusBucket === "archived" ? archivedJobs : appliedJobs;
      setStatusIdx((i) => Math.min(Math.max(i, 0), Math.max(bucketJobs.length - 1, 0)));
    }

    if (page === "config") {
      setCfgSel((i) => Math.min(Math.max(i, 0), 5));
    }
  }

  function describeProgress(progress: IngestionProgress) {
    if (progress.stage === "target") {
      return `Searching target ${progress.targetIndex}/${progress.targetTotal}: ${progress.targetTitle}`;
    }

    if (progress.stage === "serp_queries") {
      return `Target ${progress.targetIndex}/${progress.targetTotal} ${progress.targetTitle}: SerpApi ${progress.completed}/${progress.total} queries`;
    }

    if (progress.stage === "retrieved") {
      return `Target ${progress.targetIndex}/${progress.targetTotal} ${progress.targetTitle}: retrieved ${progress.retrieved}/${progress.limit} listing URLs`;
    }

    if (progress.stage === "processing") {
      return `Target ${progress.targetIndex}/${progress.targetTotal} ${progress.targetTitle}: processed ${progress.processed}/${progress.retrieved}, added ${progress.created}`;
    }

    if (progress.stage === "inserted") {
      return `Target ${progress.targetIndex}/${progress.targetTotal} ${progress.targetTitle}: added ${progress.created}, processed ${progress.processed}/${progress.retrieved}`;
    }

    return `Search complete: retrieved ${progress.retrieved}, added ${progress.created}`;
  }

  function runSearchFromDashboard() {
    if (searchRunning) {
      return;
    }

    if (!prefs.some((pref) => pref.enabled !== false)) {
      setActionError("Add or enable at least one target before running search.");
      return;
    }

    setSearchRunning(true);
    setActionError(null);
    setBusyMessage("Preparing search pipeline…");

    void (async () => {
      try {
        const result = await runIngestion({
          userId,
          perTargetLimit: 100,
          onProgress: (progress) => {
            setBusyMessage(describeProgress(progress));
            if (progress.stage === "inserted") {
              setDataEpoch((x) => x + 1);
            }
          }
        });
        setBusyMessage(`Search complete: retrieved ${result.retrieved}, added ${result.createdJobs}`);
        setDataEpoch((x) => x + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionError(msg);
        setBusyMessage("Search stopped after an error.");
        reportError("Background pipeline ingest crashed", err);
      } finally {
        setSearchRunning(false);
      }
    })();
  }

  function runApplyAllFromResults() {
    const queued = listJobsForResults(userId);

    if (!queued.length) {
      setActionError("No result jobs to apply to.");
      return;
    }

    void suspendForExternal(async () => {
      const failures: string[] = [];
      let completed = 0;

      setBusyMessage(`Launching ${queued.length} concurrent apply task${queued.length === 1 ? "" : "s"}…`);

      await Promise.allSettled(queued.map(async (job, i) => {
        const label = `${String(job.company)} · ${String(job.sourceTitle)}`;
        setBusyMessage(`Launching ${i + 1}/${queued.length}: ${truncate(label, 80)}`);

        try {
          await runApplyJobChromeExtension(String(job._id), userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${label}: ${msg}`);
          reportError(`Apply all failed for ${label}`, err);
        } finally {
          completed++;
          setDataEpoch((x) => x + 1);
          setBusyMessage(`Apply all launched ${completed}/${queued.length}; Chrome windows remain open.`);
        }
      }));

      if (failures.length) {
        setActionError(`Apply all finished with ${failures.length} failure(s). First: ${failures[0]}`);
      } else {
        setBusyMessage(`Apply all launched: ${queued.length} job${queued.length === 1 ? "" : "s"}. Chrome windows remain open.`);
      }
    });
  }

  useInput(
    (input, key) => {
      if (input === "q" && !key.ctrl && !key.meta) {
        onExit();
        return;
      }

      if (input === "1") {
        goPage("home");
        return;
      }

      if (input === "2") {
        goPage("targets");
        return;
      }

      if (input === "3") {
        goPage("results");
        return;
      }

      if (input === "4") {
        goPage("statuses");
        return;
      }

      if (input === "5") {
        goPage("metrics");
        return;
      }

      if (input === "6") {
        goPage("config");
        return;
      }

      if (page === "home" && (key.return || input === "r")) {
        runSearchFromDashboard();
        return;
      }

      if (key.tab && page !== "home") {
        setPane((p) => (p === "sidebar" ? "main" : "sidebar"));
        return;
      }

      if (key.escape && pane === "main") {
        setPane("sidebar");
        return;
      }

      if (page === "results" && input === "o") {
        void (async () => {
          const queued = listJobsNotApplied(userId);

          for (const j of queued) {
            openUrlInDefaultBrowser(normalizeApplyUrl(String(j.applyUrl)));
            await new Promise<void>((r) => setTimeout(r, 150));
          }
        })();

        return;
      }

      if (page === "targets" && input === "h") {
        void suspendForExternal(async () => {
          const ok = await confirm({
            message: "Remove all applied and dismissed job records stored locally?",
            default: false
          });

          if (ok) {
            clearJobHistoryForUser(userId);
          }
        });

        return;
      }

      if (pane === "sidebar") {
        if (key.upArrow) {
          sidebarStep(-1);
          return;
        }

        if (key.downArrow) {
          sidebarStep(1);
          return;
        }

        if (key.rightArrow || key.return) {
          enterMainPanel();
          return;
        }
      }

      if (pane === "main" && page === "results" && key.leftArrow && resultTargetIdx > 0) {
        setResultTargetIdx((x) => Math.max(0, x - 1));
        setJobIdx(0);
        return;
      }

      if (pane === "main" && key.leftArrow) {
        setPane("sidebar");
        return;
      }

      if (page === "targets" && pane === "main") {
        if (input === "a") {
          void suspendForExternal(async () => {
            await insertPreferenceFromPrompts(userId);
          });
          return;
        }

        if (input === "e" && prefs.length) {
          const i = Math.min(targetIdx, prefs.length - 1);
          const id = String(prefs[i]._id);
          const row = getPreferenceMap(userId, id);

          if (row) {
            void suspendForExternal(async () => {
              await updatePreferenceFromPrompts(userId, id, row as Record<string, unknown>);
            });
          }

          return;
        }

        if (input === "d" && prefs.length) {
          const i = Math.min(targetIdx, prefs.length - 1);
          const id = String(prefs[i]._id);
          const title = String(prefs[i].title);

          void suspendForExternal(async () => {
            const ok = await confirm({
              message: `Delete target "${title}"?`,
              default: false
            });

            if (ok) {
              deletePreference(userId, id);
            }
          });
          return;
        }

        if (input === "t" && prefs.length) {
          const i = Math.min(targetIdx, prefs.length - 1);
          const id = String(prefs[i]._id);
          const enabled = prefs[i].enabled !== false;
          setPreferenceEnabled(userId, id, !enabled);
          setDataEpoch((x) => x + 1);
          return;
        }

        if (key.upArrow) {
          if (!prefs.length) {
            setPane("sidebar");
            return;
          }

          if (targetIdx <= 0) {
            setPane("sidebar");
            return;
          }

          setTargetIdx((x) => Math.max(0, x - 1));
          return;
        }

        if (key.downArrow && prefs.length) {
          setTargetIdx((x) => Math.min(prefs.length - 1, x + 1));
          return;
        }
      }

      if (page === "config" && pane === "main") {
        const opts = ["profile", "essay", "language", "chrome", "api", "resume"] as const;

        if (key.upArrow) {
          if (cfgSel <= 0) {
            setPane("sidebar");
            return;
          }

          setCfgSel((x) => Math.max(0, x - 1));
          return;
        }

        if (key.downArrow) {
          setCfgSel((x) => Math.min(opts.length - 1, x + 1));
          return;
        }

        if (key.return) {
          const opt = opts[cfgSel];

          if (opt === "profile") {
            void suspendForExternal(async () => {
              await runProfileSettings(userId);
            });
          } else if (opt === "essay") {
            void suspendForExternal(async () => {
              await runEssaySettings(userId);
            });
          } else if (opt === "language") {
            void suspendForExternal(async () => {
              await runLanguageSettings();
            });
          } else if (opt === "chrome") {
            void suspendForExternal(async () => {
              await runChromeExtensionSettings();
            });
          } else if (opt === "api") {
            void suspendForExternal(async () => {
              await runApiSettings();
            });
          } else if (opt === "resume") {
            void suspendForExternal(async () => {
              await runResumeSettings(userId);
            });
          }

          return;
        }
      }

      if (page === "results" && pane === "main") {
        const selectedPref = prefs[Math.min(resultTargetIdx, Math.max(prefs.length - 1, 0))];
        const selectedJobs = selectedPref ? jobsByPreference.get(String(selectedPref._id)) ?? [] : [];

        if (input === "a" && jobs.length) {
          runApplyAllFromResults();
          return;
        }

        if (key.return && jobs.length) {
          const i = Math.min(jobIdx, selectedJobs.length - 1);
          const jid = String(selectedJobs[i]?._id ?? "");

          if (!jid) {
            return;
          }

          void suspendForExternal(async () => {
            setBusyMessage("Opening Chrome with JobMate extension…");
            await runApplyJobChromeExtension(jid, userId);
          });
          return;
        }

        if ((key.backspace || input === "\u007f" || input === "x") && selectedJobs.length) {
          const i = Math.min(jobIdx, selectedJobs.length - 1);
          const jid = String(selectedJobs[i]._id);
          archiveJob(userId, jid);
          setDataEpoch((x) => x + 1);
          setJobIdx((x) => Math.max(0, Math.min(x, selectedJobs.length - 2)));
          return;
        }

        if (input === "m" && selectedJobs.length) {
          const i = Math.min(jobIdx, selectedJobs.length - 1);
          const jid = String(selectedJobs[i]._id);
          markJobApplied(userId, jid);
          setDataEpoch((x) => x + 1);
          setJobIdx((x) => Math.max(0, Math.min(x, selectedJobs.length - 2)));
          return;
        }

        if (key.rightArrow && prefs.length) {
          const next = Math.min(prefs.length - 1, resultTargetIdx + 1);
          setResultTargetIdx(next);
          setJobIdx(0);
          return;
        }

        if (key.upArrow) {
          if (!selectedJobs.length) {
            setPane("sidebar");
            return;
          }

          if (jobIdx <= 0) {
            setPane("sidebar");
            return;
          }

          setJobIdx((x) => Math.max(0, x - 1));
          return;
        }

        if (key.downArrow && selectedJobs.length) {
          setJobIdx((x) => Math.min(selectedJobs.length - 1, x + 1));
          return;
        }
      }

      if (page === "statuses" && pane === "main") {
        const bucketJobs = statusBucket === "archived" ? archivedJobs : appliedJobs;

        if (input === "s" || key.rightArrow) {
          setStatusBucket((bucket) => (bucket === "archived" ? "applied" : "archived"));
          setStatusIdx(0);
          return;
        }

        if (input === "u" && bucketJobs.length) {
          const jid = String(bucketJobs[Math.min(statusIdx, bucketJobs.length - 1)]._id);
          if (statusBucket === "archived") {
            unarchiveJob(userId, jid);
          } else {
            unapplyJob(userId, jid);
          }
          setDataEpoch((x) => x + 1);
          setStatusIdx((x) => Math.max(0, Math.min(x, bucketJobs.length - 2)));
          return;
        }

        if (key.return && statusBucket === "applied" && bucketJobs.length) {
          const jid = String(bucketJobs[Math.min(statusIdx, bucketJobs.length - 1)]._id);
          void suspendForExternal(async () => {
            setBusyMessage("Generating Gmail follow-up draft…");
            const count = await openFollowUpEmails(userId, jid);
            setBusyMessage(`Opened ${count} follow-up draft${count === 1 ? "" : "s"} in Gmail.`);
          });
          return;
        }

        if (input === "d" && bucketJobs.length) {
          const jid = String(bucketJobs[Math.min(statusIdx, bucketJobs.length - 1)]._id);
          deleteJob(userId, jid);
          setDataEpoch((x) => x + 1);
          setStatusIdx((x) => Math.max(0, Math.min(x, bucketJobs.length - 2)));
          return;
        }

        if (key.upArrow) {
          if (!bucketJobs.length || statusIdx <= 0) {
            setPane("sidebar");
            return;
          }
          setStatusIdx((x) => Math.max(0, x - 1));
          return;
        }

        if (key.downArrow && bucketJobs.length) {
          setStatusIdx((x) => Math.min(bucketJobs.length - 1, x + 1));
          return;
        }
      }
    },
    { isActive: inputActive }
  );

  const cfgLabels = [
    translate("yourProfile", undefined, language),
    translate("writingSample", undefined, language),
    translate("language", undefined, language),
    translate("chromeExtension", undefined, language),
    translate("apiKeysModels", undefined, language),
    translate("resumePdfAllSearches", undefined, language)
  ];

  const selectedResultPref = prefs[Math.min(resultTargetIdx, Math.max(prefs.length - 1, 0))];
  const selectedResultJobs = selectedResultPref ? jobsByPreference.get(String(selectedResultPref._id)) ?? [] : [];
  const selectedResultJob = selectedResultJobs[Math.min(jobIdx, Math.max(selectedResultJobs.length - 1, 0))];
  const selectedStatusJobs = statusBucket === "archived" ? archivedJobs : appliedJobs;
  const selectedStatusJob =
    selectedStatusJobs.length > 0
      ? selectedStatusJobs[Math.min(statusIdx, Math.max(selectedStatusJobs.length - 1, 0))]
      : undefined;
  const detailW = Math.min(Math.max(72, Math.floor(mainW * 0.58)), Math.max(32, mainW - 24));
  const resultsW = Math.max(24, mainW - detailW - 2);
  const statusListW = resultsW;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text bold color={t.title}>
            JobMate
          </Text>
          <Text color={t.muted}> — </Text>
          <Text color={t.accent}>{translate("localDashboard", undefined, language)}</Text>
        </Box>
        <Text dimColor>
          {truncate("↑↓ pages · Tab panel · ← menu · →/Enter panel · nums 1–6 · full terminal recommended", columns - 2)}
        </Text>
      </Box>

      <BusyBanner
        message={busyMessage}
        active={
          searchRunning ||
          Boolean(busyMessage?.startsWith("Opening Chrome")) ||
          Boolean(busyMessage?.startsWith("Applying ")) ||
          Boolean(busyMessage?.startsWith("Launching ")) ||
          Boolean(busyMessage?.startsWith("Apply all launched "))
        }
      />

      <ActionErrorBanner message={actionError} columns={columns} />

      <Box flexDirection="row">
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={t.bar}
          paddingX={1}
          paddingY={1}
          width={22}
        >
          <NavRow active={page === "home"} sidebarFocus={pane === "sidebar"} k="1" label={translate("home", undefined, language)} />
          <NavRow active={page === "targets"} sidebarFocus={pane === "sidebar"} k="2" label={translate("targets", undefined, language)} />
          <NavRow active={page === "results"} sidebarFocus={pane === "sidebar"} k="3" label={translate("results", undefined, language)} />
          <NavRow active={page === "statuses"} sidebarFocus={pane === "sidebar"} k="4" label={translate("statuses", undefined, language)} />
          <NavRow active={page === "metrics"} sidebarFocus={pane === "sidebar"} k="5" label={translate("metrics", undefined, language)} />
          <NavRow active={page === "config"} sidebarFocus={pane === "sidebar"} k="6" label={translate("config", undefined, language)} />
          <Box marginTop={1}>
            <Text dimColor>
              q quit
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" paddingLeft={2} width={mainW}>
          <Box borderStyle="round" borderColor={t.accent} paddingX={1} paddingY={1} flexDirection="column">
            {page === "home" && (
              <>
                <Text bold color={t.ok}>
                  {translate("overview", undefined, language)}
                </Text>
                <Text color={t.muted}>
                  {profile?.fullName?.trim()
                    ? `Signed in as ${profile.fullName.trim()}`
                    : `Account ${profile?.email ?? userId.slice(0, 8)}…`}
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <Stat label={translate("roleTargets", undefined, language)} value={String(prefs.length)} />
                  <Stat label={translate("openJobs", undefined, language)} value={String(jobs.length)} />
                  <Stat label={translate("applied", undefined, language)} value={String(appliedJobs.length)} />
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text inverse color={searchRunning ? t.warn : t.ok}>
                    {searchRunning ? "[ running ] Search pipeline" : "[ Enter / r ] Run search pipeline"}
                  </Text>
                  <Text color={t.muted}>
                    Searches enabled targets, retrieves up to 100 results per target, and adds results as each listing finishes.
                  </Text>
                </Box>
              </>
            )}

            {page === "targets" && (
              <>
                <Text bold color={t.ok}>
                  {translate("roleTargets", undefined, language)}
                </Text>
                <Text color={t.muted}>
                  Tab panel · ↑↓ rows · a add · e edit · t enable/disable · d delete · h clear history · ← menu
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {prefs.length === 0 ? (
                    <Text color={t.warn}>{translate("noTargetsYet", undefined, language)}</Text>
                  ) : (
                    prefs.slice(0, listMax).map((p, i) => {
                      const locs = (p.locations as string[]).join(", ");
                      const enabled = p.enabled !== false;
                      const line = `${enabled ? "on " : "off"} · ${String(p.title)} · ${locs}`;
                      const hit = i === Math.min(targetIdx, prefs.length - 1);

                      return (
                        <Text key={String(p._id)} inverse={hit} wrap="truncate">
                          {hit ? "❯ " : "  "}
                          {truncate(line, mainW - 4)}
                        </Text>
                      );
                    })
                  )}
                </Box>
              </>
            )}

            {page === "results" && (
              <>
                <Text bold color={t.ok}>
                  Results
                </Text>
                <Text color={t.muted}>
                  Tab panel · ←→ target columns · ↑↓ result · Enter apply · m mark applied · a apply all · Backspace archive · o open all
                </Text>
                <Box marginTop={1}>
                  <Text inverse color={jobs.length ? t.ok : t.muted}>
                    [ a ] Apply to all
                  </Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Box flexDirection="row">
                    <Box flexDirection="row" width={resultsW}>
                      {prefs.length === 0 ? (
                        <Text color={t.warn}>{translate("noTargetsYet", undefined, language)}</Text>
                      ) : (
                        prefs.map((p, col) => {
                          const colJobs = jobsByPreference.get(String(p._id)) ?? [];
                          const colW = Math.max(16, Math.floor((resultsW - 2) / Math.max(1, Math.min(prefs.length, 4))));
                          const activeCol = col === Math.min(resultTargetIdx, prefs.length - 1);

                          return (
                            <Box key={String(p._id)} flexDirection="column" width={colW} marginRight={1}>
                              <Text bold color={activeCol ? t.ok : t.muted} wrap="truncate">
                                {truncate(String(p.title), colW - 1)}
                              </Text>
                              {colJobs.slice(0, listMax).map((j, row) => {
                                const hit = activeCol && row === Math.min(jobIdx, colJobs.length - 1);
                                return (
                                  <Text key={String(j._id)} inverse={hit} wrap="truncate">
                                    {truncate(`${hit ? "❯ " : "  "}${String(j.company)} · ${String(j.sourceTitle)}`, colW - 1)}
                                  </Text>
                                );
                              })}
                              {!colJobs.length && <Text color={t.warn}>{translate("noResults", undefined, language)}</Text>}
                            </Box>
                          );
                        })
                      )}
                    </Box>
                    <ResultDetail job={selectedResultJob} width={detailW} />
                  </Box>
                </Box>
              </>
            )}

            {page === "statuses" && (
              <>
                <Text bold color={t.ok}>
                  Statuses
                </Text>
                <Text color={t.muted}>
                  Tab panel · s switch bucket · ↑↓ rows · Enter follow-up email in Applied · u unarchive/unapply · d delete · ← menu
                </Text>
                <Box marginTop={1}>
                  <Text inverse={statusBucket === "archived"}> {translate("archived", undefined, language)} {archivedJobs.length} </Text>
                  <Text> </Text>
                  <Text inverse={statusBucket === "applied"}> {translate("appliedPlural", undefined, language)} {appliedJobs.length} </Text>
                </Box>
                <Box marginTop={1} flexDirection="row">
                  <Box flexDirection="column" width={statusListW}>
                    {selectedStatusJobs.length === 0 ? (
                      <Text color={t.warn}>No jobs in this bucket.</Text>
                    ) : (
                      selectedStatusJobs.slice(0, listMax).map((j, i) => {
                        const line = `${String(j.sourceTitle)} — ${String(j.company)} (${String(j.sourceHost)})`;
                        const contactsArr =
                          statusBucket === "applied" && asStringArray(j.appliedAtHiringContacts).length
                            ? asStringArray(j.appliedAtHiringContacts)
                            : asStringArray(j.hiringContacts);
                        const linksArr =
                          statusBucket === "applied" && asStringArray(j.appliedAtLinkedinLinks).length
                            ? asStringArray(j.appliedAtLinkedinLinks)
                            : asStringArray(j.linkedinLinks);
                        const meta =
                          statusBucket === "applied"
                            ? ` · applied ${daysAgo(j.appliedAt)} · ${contactsArr.length} emails · ${linksArr.length} LinkedIn`
                            : "";
                        const hit = i === Math.min(statusIdx, selectedStatusJobs.length - 1);

                        return (
                          <Text key={String(j._id)} inverse={hit} wrap="truncate">
                            {hit ? "❯ " : "  "}
                            {truncate(`${line}${meta}`, statusListW - 4)}
                          </Text>
                        );
                      })
                    )}
                  </Box>
                  {statusBucket === "applied" ? (
                    <AppliedDetail job={selectedStatusJob} width={detailW} />
                  ) : (
                    <ResultDetail job={selectedStatusJob} width={detailW} />
                  )}
                </Box>
              </>
            )}

            {page === "metrics" && (
              <>
                <Text bold color={t.ok}>
                  Metrics
                </Text>
                <Text color={t.muted}>Daily retrieved and applied counts</Text>
                <Box marginTop={1} flexDirection="column">
                  {metrics.length === 0 ? (
                    <Text color={t.warn}>No metrics yet.</Text>
                  ) : (
                    metrics.map((row) => (
                      <Text key={row.day}>
                        <Text color={t.muted}>{row.day}</Text>
                        <Text> · retrieved </Text>
                        <Text color={t.accent}>{String(row.retrieved)}</Text>
                        <Text> · applied </Text>
                        <Text color={t.ok}>{String(row.applied)}</Text>
                      </Text>
                    ))
                  )}
                </Box>
              </>
            )}

            {page === "config" && (
              <>
                <Text bold color={t.ok}>
                  Configuration
                </Text>
                <Text color={t.muted}>
                  Tab panel · ↑↓ · Enter open · ← menu
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={t.muted}>
                    Data: {truncate(getFilesDir(), mainW - 8)}
                  </Text>
                  {cfgLabels.map((lab, i) => {
                    const hit = i === cfgSel;

                    return (
                      <Text key={lab} inverse={hit}>
                        {hit ? "❯ " : "  "}
                        {lab}
                      </Text>
                    );
                  })}
                </Box>
              </>
            )}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>
              Esc/← menu · →/Enter panel · Tab · 1–6 · q quit
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function NavRow(props: { active: boolean; sidebarFocus: boolean; k: string; label: string }) {
  const mark =
    props.active && props.sidebarFocus ? "▶" : props.active ? "▸" : " ";

  return (
    <Box>
      <Text color={props.active ? t.ok : t.muted}>{mark}</Text>
      <Text> </Text>
      <Text bold color={t.warn}>
        {props.k}
      </Text>
      <Text> </Text>
      <Text bold color={props.active ? t.hi : t.muted}>
        {props.label}
      </Text>
    </Box>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <Box>
      <Text color={t.muted}>{props.label}: </Text>
      <Text color={t.accent}>{props.value}</Text>
    </Box>
  );
}

function ResultDetail(props: { job: Record<string, unknown> | undefined; width: number }) {
  const language = getAppLanguage();
  if (!props.job) {
    return (
      <Box flexDirection="column" width={props.width}>
        <Text bold color={t.muted}>
          {translate("details", undefined, language)}
        </Text>
        <Text color={t.warn}>Select a result.</Text>
      </Box>
    );
  }

  const links = asStringArray(props.job.linkedinLinks);
  const contacts = asStringArray(props.job.hiringContacts);

  return (
    <Box flexDirection="column" width={props.width}>
      <Text bold color={t.ok}>
        {translate("details", undefined, language)}
      </Text>
      <Text wrap="wrap">{String(props.job.summary ?? "No summary available.")}</Text>
      <Box marginTop={1} flexDirection="column">
        <Stat label="Retrieved" value={formatLocalDateTime(props.job.discoveredAt)} />
        <Stat label="Comp" value={compactDetail(props.job.compensationRange)} />
        <Stat label="Location" value={compactDetail(props.job.location ?? translate("unknown", undefined, language))} />
        <Stat label="Homepage" value={compactDetail(props.job.companyHomepage)} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={t.muted}>LinkedIn</Text>
        {(links.length ? links : [translate("notFound", undefined, language)]).slice(0, 3).map((link) => (
          <Text key={link}>
            {link}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={t.muted}>Hiring contacts</Text>
        {(contacts.length ? contacts : [translate("notFound", undefined, language)]).slice(0, 3).map((contact) => (
          <Text key={contact}>
            {contact}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function AppliedDetail(props: { job: Record<string, unknown> | undefined; width: number }) {
  const language = getAppLanguage();
  if (!props.job) {
    return (
      <Box flexDirection="column" width={props.width}>
        <Text bold color={t.muted}>
          {translate("details", undefined, language)}
        </Text>
        <Text color={t.warn}>Select an applied job.</Text>
      </Box>
    );
  }

  const linksSnap = asStringArray(props.job.appliedAtLinkedinLinks);
  const contactsSnap = asStringArray(props.job.appliedAtHiringContacts);
  const links = linksSnap.length ? linksSnap : asStringArray(props.job.linkedinLinks);
  const contacts = contactsSnap.length ? contactsSnap : asStringArray(props.job.hiringContacts);
  const applicationUrl = String(props.job.appliedApplicationUrl ?? props.job.applyUrl ?? "").trim();

  return (
    <Box flexDirection="column" width={props.width}>
      <Text bold color={t.ok}>
        {translate("details", undefined, language)}
      </Text>
      <Text wrap="wrap">{String(props.job.summary ?? "No summary available.")}</Text>
      <Box marginTop={1} flexDirection="column">
        <Stat label="Applied" value={formatLocalDateTime(props.job.appliedAt)} />
        <Stat label="Comp" value={compactDetail(props.job.compensationRange)} />
        <Stat label="Location" value={compactDetail(props.job.location ?? translate("unknown", undefined, language))} />
        <Stat label="Application URL" value={compactDetail(applicationUrl)} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={t.muted}>LinkedIn</Text>
        {(links.length ? links : [translate("notFound", undefined, language)]).slice(0, 8).map((link) => (
          <Text key={link}>
            {link}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={t.muted}>Hiring contacts</Text>
        {(contacts.length ? contacts : [translate("notFound", undefined, language)]).slice(0, 8).map((contact) => (
          <Text key={contact}>
            {contact}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function BusyBanner(props: { message: string | null; active: boolean }) {
  const { frame } = useAnimation({ interval: 80, isActive: props.active });
  const chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  if (!props.message) {
    return null;
  }

  return (
    <Box marginBottom={1}>
      <Text color={props.active ? t.accent : t.ok}>{props.active ? chars[frame % chars.length] : "✓"} </Text>
      <Text bold color={t.ok}>
        {props.message}
      </Text>
    </Box>
  );
}

function ActionErrorBanner(props: { message: string | null; columns: number }) {
  if (!props.message) {
    return null;
  }

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color={t.danger}>
        Error
      </Text>
      <Text color={t.danger}>{truncate(props.message, Math.max(24, props.columns - 4))}</Text>
    </Box>
  );
}
