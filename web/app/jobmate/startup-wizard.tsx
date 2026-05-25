import { useEffect, useState } from "react";

import type { JobmateSqlite } from "./sqlite-client";
import {
  SETTING_GEMINI_API_KEY,
  SETTING_GEMINI_MODEL,
  SETTING_INITIAL_SETUP_COMPLETE,
  SETTING_LANGUAGE,
  SETTING_NOTIFICATION_WEBHOOK_URL,
  SETTING_SERPAPI_API_KEY
} from "./kv-keys";

type WizardShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
};

function WizardShell({ title, subtitle, children }: WizardShellProps) {
  return (
    <div className="min-h-screen bg-white px-4 py-10 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto max-w-xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{subtitle}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function inputClass() {
  return "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
}

function labelClass() {
  return "block text-sm font-medium text-gray-700 dark:text-gray-300";
}

export function BrowserProfileWizard(props: { sqlite: JobmateSqlite; onCreatedUserId: (id: string) => void }) {
  const { sqlite, onCreatedUserId } = props;
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [currentLocation, setCurrentLocation] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [preferredCompRange, setPreferredCompRange] = useState("");
  const [workHistory, setWorkHistory] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const fn = fullName.trim();
    const em = email.trim().toLowerCase();

    if (!fn || !em) {
      setSubmitError("Full name and email are required.");
      return;
    }

    setSubmitting(true);

    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const loc = currentLocation.trim();

      await sqlite.run(
        `INSERT INTO users (
          id, email, full_name, location, current_location, phone, linkedin_url, preferred_comp_range,
          cover_letter_template, website, work_history, skills, essay, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          em,
          fn,
          loc,
          loc,
          phone.trim(),
          linkedinUrl.trim(),
          preferredCompRange.trim(),
          "",
          "",
          workHistory.trim(),
          "",
          "",
          now,
          now
        ]
      );

      onCreatedUserId(id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WizardShell
      title="JobMate"
      subtitle="Your profile is stored only in this browser (IndexedDB SQLite)."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelClass()} htmlFor="jm-fn">
            Full name
          </label>
          <input
            id="jm-fn"
            className={inputClass()}
            value={fullName}
            onChange={(ev) => setFullName(ev.target.value)}
            autoComplete="name"
            required
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-em">
            Email
          </label>
          <input
            id="jm-em"
            type="email"
            className={inputClass()}
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-loc">
            Current location (city, state)
          </label>
          <input
            id="jm-loc"
            className={inputClass()}
            value={currentLocation}
            onChange={(ev) => setCurrentLocation(ev.target.value)}
            autoComplete="address-level2"
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-ph">
            Phone number
          </label>
          <input
            id="jm-ph"
            type="tel"
            className={inputClass()}
            value={phone}
            onChange={(ev) => setPhone(ev.target.value)}
            autoComplete="tel"
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-li">
            LinkedIn URL
          </label>
          <input
            id="jm-li"
            className={inputClass()}
            value={linkedinUrl}
            onChange={(ev) => setLinkedinUrl(ev.target.value)}
            autoComplete="url"
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-comp">
            Preferred compensation range
          </label>
          <input
            id="jm-comp"
            className={inputClass()}
            value={preferredCompRange}
            onChange={(ev) => setPreferredCompRange(ev.target.value)}
          />
        </div>
        <div>
          <label className={labelClass()} htmlFor="jm-wh">
            Work history
          </label>
          <textarea
            id="jm-wh"
            rows={8}
            className={inputClass()}
            value={workHistory}
            onChange={(ev) => setWorkHistory(ev.target.value)}
          />
        </div>
        {submitError ? <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          {submitting ? "Saving…" : "Save profile"}
        </button>
      </form>
    </WizardShell>
  );
}

export function BrowserSetupWizard(props: { sqlite: JobmateSqlite; userId: string; onDone: () => void }) {
  const { sqlite, userId, onDone } = props;
  const [loaded, setLoaded] = useState(false);
  const [profileRow, setProfileRow] = useState<Record<string, unknown> | null>(null);

  const [language, setLanguage] = useState<"en" | "fr">("en");
  const [serpApiKey, setSerpApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3.1-flash-lite");
  const [webhook, setWebhook] = useState("");
  const [website, setWebsite] = useState("");
  const [currentLocation, setCurrentLocation] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [preferredCompRange, setPreferredCompRange] = useState("");
  const [coverLetterTemplate, setCoverLetterTemplate] = useState("");
  const [skills, setSkills] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const existingLang = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_LANGUAGE]
        );

        const rows = await sqlite.all<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId]);
        const row = rows[0] ?? null;

        if (cancelled) {
          return;
        }

        setProfileRow(row);

        const langVal = existingLang[0]?.value;

        if (langVal === "fr" || langVal === "en") {
          setLanguage(langVal);
        }

        if (row) {
          setWebsite(String(row.website ?? ""));
          setCurrentLocation(String(row.current_location ?? row.location ?? ""));
          setPhone(String(row.phone ?? ""));
          setLinkedinUrl(String(row.linkedin_url ?? ""));
          setPreferredCompRange(String(row.preferred_comp_range ?? ""));
          setCoverLetterTemplate(String(row.cover_letter_template ?? ""));
          setSkills(String(row.skills ?? ""));
        }

        const serp = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_SERPAPI_API_KEY]
        );
        const gem = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_GEMINI_API_KEY]
        );
        const mod = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_GEMINI_MODEL]
        );
        const hook = await sqlite.all<{ value: string }>(
          "SELECT value FROM kv_settings WHERE key = ?",
          [SETTING_NOTIFICATION_WEBHOOK_URL]
        );

        if (cancelled) {
          return;
        }

        setSerpApiKey(serp[0]?.value ?? "");
        setGeminiApiKey(gem[0]?.value ?? "");
        setGeminiModel(mod[0]?.value?.trim() ? String(mod[0].value) : "gemini-3.1-flash-lite");
        setWebhook(hook[0]?.value ?? "");
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sqlite, userId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!profileRow) {
      setSubmitError("Missing user profile.");
      return;
    }

    const email = String(profileRow.email ?? "").trim().toLowerCase();
    const fullName = String(profileRow.full_name ?? "").trim();

    if (!email || !fullName) {
      setSubmitError("Missing user profile.");
      return;
    }

    setSubmitting(true);

    try {
      const now = new Date().toISOString();
      const loc = currentLocation.trim();
      const modelTrim = geminiModel.trim() || "gemini-3.1-flash-lite";
      const workHistory = String(profileRow.work_history ?? "");

      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_LANGUAGE,
        language
      ]);
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
        modelTrim
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_NOTIFICATION_WEBHOOK_URL,
        webhook.trim()
      ]);
      await sqlite.run(`INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)`, [
        SETTING_INITIAL_SETUP_COMPLETE,
        "1"
      ]);

      await sqlite.run(
        `UPDATE users SET email = ?, full_name = ?, location = ?, current_location = ?, phone = ?, linkedin_url = ?, preferred_comp_range = ?, cover_letter_template = ?, website = ?, work_history = ?, skills = ?, updated_at = ?
         WHERE id = ?`,
        [
          email,
          fullName,
          loc,
          loc,
          phone.trim(),
          linkedinUrl.trim(),
          preferredCompRange.trim(),
          coverLetterTemplate.trim(),
          website.trim(),
          workHistory,
          skills.trim(),
          now,
          userId
        ]
      );

      onDone();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!loaded || !profileRow) {
    return (
      <WizardShell title="First-time setup" subtitle="Loading…">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      </WizardShell>
    );
  }

  return (
    <WizardShell
      title="First-time setup"
      subtitle="API keys and settings are stored only in this browser (IndexedDB SQLite)."
    >
      <form onSubmit={onSubmit} className="space-y-6">
        <fieldset className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">Language</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="jm-lang" checked={language === "en"} onChange={() => setLanguage("en")} />
            English
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="jm-lang" checked={language === "fr"} onChange={() => setLanguage("fr")} />
            Français
          </label>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">API keys</legend>
          <div>
            <label className={labelClass()} htmlFor="jm-serp">
              SerpApi API key (serpapi.com)
            </label>
            <input
              id="jm-serp"
              className={inputClass()}
              value={serpApiKey}
              onChange={(ev) => setSerpApiKey(ev.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-gem">
              Gemini API key (optional)
            </label>
            <input
              id="jm-gem"
              className={inputClass()}
              value={geminiApiKey}
              onChange={(ev) => setGeminiApiKey(ev.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-model">
              Gemini model
            </label>
            <input
              id="jm-model"
              className={inputClass()}
              value={geminiModel}
              onChange={(ev) => setGeminiModel(ev.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-whurl">
              Webhook URL for digest notifications (optional)
            </label>
            <input
              id="jm-whurl"
              className={inputClass()}
              value={webhook}
              onChange={(ev) => setWebhook(ev.target.value)}
              autoComplete="off"
            />
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">Profile details</legend>
          <div>
            <label className={labelClass()} htmlFor="jm-site">
              Your website (portfolio, GitHub, etc.)
            </label>
            <input
              id="jm-site"
              className={inputClass()}
              value={website}
              onChange={(ev) => setWebsite(ev.target.value)}
              autoComplete="url"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-cloc">
              Current location (city, state)
            </label>
            <input
              id="jm-cloc"
              className={inputClass()}
              value={currentLocation}
              onChange={(ev) => setCurrentLocation(ev.target.value)}
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-phone">
              Phone number
            </label>
            <input
              id="jm-phone"
              type="tel"
              className={inputClass()}
              value={phone}
              onChange={(ev) => setPhone(ev.target.value)}
              autoComplete="tel"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-li2">
              LinkedIn URL
            </label>
            <input
              id="jm-li2"
              className={inputClass()}
              value={linkedinUrl}
              onChange={(ev) => setLinkedinUrl(ev.target.value)}
              autoComplete="url"
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-pcr">
              Preferred compensation range
            </label>
            <input
              id="jm-pcr"
              className={inputClass()}
              value={preferredCompRange}
              onChange={(ev) => setPreferredCompRange(ev.target.value)}
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-cover">
              Cover letter template (optional tone and length reference)
            </label>
            <textarea
              id="jm-cover"
              rows={6}
              className={inputClass()}
              value={coverLetterTemplate}
              onChange={(ev) => setCoverLetterTemplate(ev.target.value)}
            />
          </div>
          <div>
            <label className={labelClass()} htmlFor="jm-skills">
              Skills (comma-separated or short list)
            </label>
            <input
              id="jm-skills"
              className={inputClass()}
              value={skills}
              onChange={(ev) => setSkills(ev.target.value)}
            />
          </div>
        </fieldset>

        {submitError ? <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p> : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          {submitting ? "Saving…" : "Finish setup"}
        </button>
      </form>
    </WizardShell>
  );
}
