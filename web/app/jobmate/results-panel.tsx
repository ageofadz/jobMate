import { useState } from "react";

import { normalizeApplyUrl } from "@/lib/apply-url";

import { companyLogoProxyPath } from "./company-logo-url";
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
  if (oneLine.length <= 700) {
    return oneLine;
  }
  return `${oneLine.slice(0, 699)}…`;
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
    <div className="jm-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="jm-panel max-h-[80vh] w-full max-w-lg overflow-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">{job.company}</h3>
            <p className="jm-muted text-sm">{job.source_title}</p>
          </div>
          <button type="button" onClick={onClose} className="jm-muted text-sm hover:opacity-80">
            Close
          </button>
        </div>
        {busy ? <p className="jm-muted mt-4 text-sm">Loading contacts…</p> : null}
        {error ? <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="mt-4 space-y-4">
          <div>
            <p className="jm-section-title text-xs">LinkedIn</p>
            <ul className="mt-2 space-y-1">
              {linkedinLinks.length ? (
                linkedinLinks.map((link) => (
                  <li key={link}>
                    <a href={link} target="_blank" rel="noreferrer" className="jm-link text-sm">
                      {link}
                    </a>
                  </li>
                ))
              ) : (
                <li className="jm-muted text-sm">None found.</li>
              )}
            </ul>
          </div>
          <div>
            <p className="jm-section-title text-xs">Email</p>
            <ul className="mt-2 space-y-1">
              {hiringContacts.length ? (
                hiringContacts.map((email) => (
                  <li key={email} className="text-sm">
                    {email}
                  </li>
                ))
              ) : (
                <li className="jm-muted text-sm">None found.</li>
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
  const logoSrc = companyLogoProxyPath(job.company_logo_url);

  return (
    <article
      className={`jm-card relative box-border flex h-[360px] w-full min-w-0 max-w-[470px] ${selected ? "jm-selected" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="absolute left-3 top-3 z-10 h-4 w-4"
      />
      <div className="flex min-w-0 flex-1 p-4 pl-10">
        <div className="flex min-w-0 flex-1 flex-col justify-between pr-3">
          <div className="min-w-0 space-y-1">
            <h3 className="line-clamp-2 text-base font-semibold leading-snug">{job.source_title}</h3>
            <p className="truncate text-sm font-medium">{job.company}</p>
            <p className="jm-muted truncate text-sm">{job.location.trim() || "Unknown location"}</p>
            {summary ? (
              <p className="jm-muted line-clamp-7 text-xs leading-snug">{summary}</p>
            ) : null}
          </div>
          <div className="jm-muted space-y-0.5 text-xs">
            <p>Posted: {formatPostedDate(job.posted_at)}</p>
            <p>Retrieved: {formatRetrievedDate(job.discovered_at)}</p>
          </div>
        </div>
        <div className="flex w-[132px] shrink-0 flex-col items-stretch justify-between">
          <div className="jm-card-logo flex h-20 w-full shrink-0 overflow-hidden">
            {logoSrc ? (
              <img src={logoSrc} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="jm-muted flex h-full w-full items-center justify-center text-[10px] uppercase tracking-wide">
                No logo
              </span>
            )}
          </div>
          <div className="flex w-full flex-col gap-1">
            <button type="button" className="jm-btn-primary w-full px-2 py-1 text-xs" onClick={onApply}>
              Apply
            </button>
            <button type="button" className="jm-btn-outline w-full px-2 py-1 text-xs normal-case" onClick={onViewListing}>
              View listing
            </button>
            <button type="button" className="jm-btn-outline w-full px-2 py-1 text-xs normal-case" onClick={onMarkApplied}>
              Mark applied
            </button>
            <button type="button" className="jm-btn-ghost w-full px-2 py-1 text-xs normal-case" onClick={onArchive}>
              Archive
            </button>
            <button type="button" className="jm-btn-ghost w-full px-2 py-1 text-xs normal-case" onClick={onViewContacts}>
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
        <p className="jm-muted mt-1 text-sm">Jobs in new or reviewed status.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b pb-4" style={{ borderColor: "var(--color-border)" }}>
        <button
          type="button"
          onClick={() => onFilter("all")}
          className={filter === "all" ? "jm-tab jm-tab-active" : "jm-tab"}
        >
          All
        </button>
        {prefs.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onFilter(p.id)}
            className={filter === p.id ? "jm-tab jm-tab-active" : "jm-tab"}
          >
            {p.title}
          </button>
        ))}
      </div>
      {jobs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select all
          </label>
          {bulkBar ? (
            <>
              <span className="jm-muted text-sm">{selected.size} selected</span>
              <button type="button" onClick={() => void runBulk("apply")} className="jm-btn-primary px-3 py-1.5 text-sm">
                Mass apply
              </button>
              <button type="button" onClick={() => void runBulk("mark")} className="jm-btn-ghost px-3 py-1.5 text-sm">
                Mass mark applied
              </button>
              <button type="button" onClick={() => void runBulk("archive")} className="jm-btn-ghost px-3 py-1.5 text-sm">
                Mass archive
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {jobs.length === 0 ? (
        <p className="jm-muted text-sm">No result jobs.</p>
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
