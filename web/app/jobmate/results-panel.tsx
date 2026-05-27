import { useState } from "react";

import { normalizeApplyUrl } from "@/lib/apply-url";

import { openBackgroundTabViaExtension } from "./extension-open-tab";

export type ResultJobRow = {
  id: string;
  preference_id: string;
  company: string;
  source_title: string;
  status: string;
  discovered_at: string;
  posted_at: string | null;
  company_logo_url: string | null;
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

function formatPostedDate(value: string | null): string {
  if (!value) {
    return "Unknown";
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatRetrievedDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function cardSummary(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "";
  }
  if (oneLine.length <= 400) {
    return oneLine;
  }
  return `${oneLine.slice(0, 399)}…`;
}

export function ContactsModal(props: {
  job: ResultJobRow;
  linkedinLinks: string[];
  hiringContacts: string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { job, linkedinLinks, hiringContacts, busy, error, onClose } = props;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">{job.company}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">{job.source_title}</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
            Close
          </button>
        </div>
        {busy ? <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading contacts…</p> : null}
        {error ? <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">LinkedIn</p>
            <ul className="mt-2 space-y-1">
              {linkedinLinks.length ? (
                linkedinLinks.map((link) => (
                  <li key={link}>
                    <a href={link} target="_blank" rel="noreferrer" className="text-sm text-blue-700 underline dark:text-blue-400">
                      {link}
                    </a>
                  </li>
                ))
              ) : (
                <li className="text-sm text-gray-500 dark:text-gray-400">None found.</li>
              )}
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Email</p>
            <ul className="mt-2 space-y-1">
              {hiringContacts.length ? (
                hiringContacts.map((email) => (
                  <li key={email} className="text-sm text-gray-800 dark:text-gray-200">
                    {email}
                  </li>
                ))
              ) : (
                <li className="text-sm text-gray-500 dark:text-gray-400">None found.</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobResultCard(props: {
  job: ResultJobRow;
  selected: boolean;
  onToggleSelect: () => void;
  onApply: () => void;
  onViewListing: () => void;
  onMarkApplied: () => void;
  onArchive: () => void;
  onViewContacts: () => void;
}) {
  const { job, selected, onToggleSelect, onApply, onViewListing, onMarkApplied, onArchive, onViewContacts } = props;
  const summary = cardSummary(job.summary);
  const btn =
    "rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800";

  return (
    <article className="relative box-border flex h-[300px] w-[470px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="absolute left-3 top-3 z-10 h-4 w-4"
      />
      <div className="flex min-w-0 flex-1 p-4 pl-10">
        <div className="flex min-w-0 flex-1 flex-col justify-between pr-3">
          <div className="min-w-0 space-y-1">
            <h3 className="line-clamp-2 text-base font-semibold leading-snug text-gray-900 dark:text-gray-100">{job.source_title}</h3>
            <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{job.company}</p>
            <p className="truncate text-sm text-gray-600 dark:text-gray-400">{job.location.trim() || "Unknown location"}</p>
            {summary ? (
              <p className="line-clamp-6 text-xs leading-snug text-gray-500 dark:text-gray-400">{summary}</p>
            ) : null}
          </div>
          <div className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            <p>Posted: {formatPostedDate(job.posted_at)}</p>
            <p>Retrieved: {formatRetrievedDate(job.discovered_at)}</p>
          </div>
        </div>
        <div className="flex w-[128px] shrink-0 flex-col items-end justify-between">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            {job.company_logo_url ? (
              <img src={job.company_logo_url} alt="" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="px-1 text-center text-[10px] uppercase tracking-wide text-gray-400">No logo</span>
            )}
          </div>
          <div className="flex w-full flex-col gap-1">
            <button type="button" className={btn} onClick={onApply}>
              Apply
            </button>
            <button type="button" className={btn} onClick={onViewListing}>
              View listing
            </button>
            <button type="button" className={btn} onClick={onMarkApplied}>
              Mark applied
            </button>
            <button type="button" className={btn} onClick={onArchive}>
              Archive
            </button>
            <button type="button" className={btn} onClick={onViewContacts}>
              View contacts
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ResultsPanel(props: {
  prefs: { id: string; title: string }[];
  jobs: ResultJobRow[];
  filter: string | "all";
  onFilter: (v: string | "all") => void;
  onArchive: (jobId: string) => void | Promise<void>;
  onMarkApplied: (jobId: string, applyUrl: string) => void | Promise<void>;
  onChromeApply: (jobId: string) => void | Promise<void>;
  onFetchContacts: (job: ResultJobRow) => Promise<{ linkedinLinks: string[]; hiringContacts: string[] }>;
}) {
  const { prefs, jobs, filter, onFilter, onArchive, onMarkApplied, onChromeApply, onFetchContacts } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [contactsJob, setContactsJob] = useState<ResultJobRow | null>(null);
  const [contactsLinkedin, setContactsLinkedin] = useState<string[]>([]);
  const [contactsEmails, setContactsEmails] = useState<string[]>([]);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);

  const allSelected = jobs.length > 0 && jobs.every((j) => selected.has(j.id));

  function toggleOne(jobId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(jobs.map((j) => j.id)));
  }

  async function runBulk(action: "apply" | "mark" | "archive") {
    const ids = Array.from(selected);
    for (const id of ids) {
      const job = jobs.find((j) => j.id === id);
      if (!job) {
        continue;
      }
      if (action === "apply") {
        await onChromeApply(job.id);
      } else if (action === "mark") {
        await onMarkApplied(job.id, normalizeApplyUrl(job.apply_url));
      } else {
        await onArchive(job.id);
      }
    }
    setSelected(new Set());
  }

  async function openContacts(job: ResultJobRow) {
    const storedLinkedin = parseStoredJsonStrings(job.linkedin_links);
    const storedContacts = parseStoredJsonStrings(job.hiring_contacts);
    setContactsJob(job);
    setContactsLinkedin(storedLinkedin);
    setContactsEmails(storedContacts);
    setContactsError(null);

    if (storedLinkedin.length || storedContacts.length) {
      return;
    }

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

  const bulkBar = selected.size > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Results</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Jobs in new or reviewed status.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
      {jobs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select all
          </label>
          {bulkBar ? (
            <>
              <span className="text-sm text-gray-500 dark:text-gray-400">{selected.size} selected</span>
              <button
                type="button"
                onClick={() => void runBulk("apply")}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900"
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
      ) : null}
      {jobs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No result jobs.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid w-max grid-cols-3 gap-4">
            {jobs.map((j) => (
              <JobResultCard
                key={j.id}
                job={j}
                selected={selected.has(j.id)}
                onToggleSelect={() => toggleOne(j.id)}
                onApply={() => void onChromeApply(j.id)}
                onViewListing={() => void openBackgroundTabViaExtension(j.source_url)}
                onMarkApplied={() => void onMarkApplied(j.id, normalizeApplyUrl(j.apply_url))}
                onArchive={() => void onArchive(j.id)}
                onViewContacts={() => void openContacts(j)}
              />
            ))}
          </div>
        </div>
      )}
      {contactsJob ? (
        <ContactsModal
          job={contactsJob}
          linkedinLinks={contactsLinkedin}
          hiringContacts={contactsEmails}
          busy={contactsBusy}
          error={contactsError}
          onClose={() => {
            setContactsJob(null);
            setContactsError(null);
          }}
        />
      ) : null}
    </div>
  );
}
