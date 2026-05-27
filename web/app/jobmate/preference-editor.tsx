import { useState } from "react";

import {
  boardDomainsFromOptionIds,
  boardOptionIdsFromDomains,
  DEFAULT_BOARD_DOMAINS
} from "../../../lib/board-options";
import { formatLocationsForInput, splitLocations } from "../../../lib/validators";
import { BoardMultiSelect } from "./board-multiselect";
import { enrichPreferenceInput, preferenceInputSchema } from "./browser-preference";
import type { JobmateSqlite } from "./sqlite-client";

function ic() {
  return "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
}

function lc() {
  return "block text-sm font-medium text-gray-700 dark:text-gray-300";
}

function splitComma(raw: string) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function PreferenceEditorModal(props: {
  sqlite: JobmateSqlite;
  userId: string;
  mode: "add" | "edit";
  initial: Record<string, unknown> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { sqlite, userId, mode, initial, onClose, onSaved } = props;
  const [title, setTitle] = useState(() => String(initial?.title ?? ""));
  const [locationsRaw, setLocationsRaw] = useState(() =>
    initial?.locations ? formatLocationsForInput(JSON.parse(String(initial.locations))) : ""
  );
  const [boardOptionIds, setBoardOptionIds] = useState(() =>
    initial?.board_domains
      ? boardOptionIdsFromDomains(JSON.parse(String(initial.board_domains)))
      : boardOptionIdsFromDomains(DEFAULT_BOARD_DOMAINS)
  );
  const [keywordSeedRaw, setKeywordSeedRaw] = useState(() =>
    initial?.keyword_seed ? JSON.parse(String(initial.keyword_seed)).join(", ") : ""
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const parsed = preferenceInputSchema.safeParse({
      title,
      locations: splitLocations(locationsRaw),
      boardDomains: boardDomainsFromOptionIds(boardOptionIds),
      keywordSeed: keywordSeedRaw ? splitComma(keywordSeedRaw) : []
    });

    if (!parsed.success) {
      setSubmitError(parsed.error.issues.map((i) => i.message).join(" "));
      return;
    }

    const enriched = enrichPreferenceInput(parsed.data);
    const now = new Date().toISOString();
    setSubmitting(true);

    try {
      if (mode === "add") {
        const id = crypto.randomUUID();
        await sqlite.run(
          `INSERT INTO preferences (
            id, user_id, title, enabled, locations, board_domains, keyword_seed, generated_keywords,
            search_queries, search_after_days, context_block, timezone, schedule_hour_local, google_jobs_url, resume_asset_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            userId,
            enriched.title,
            1,
            JSON.stringify(enriched.locations),
            JSON.stringify(enriched.boardDomains),
            JSON.stringify(enriched.keywordSeed),
            JSON.stringify(enriched.generatedKeywords),
            JSON.stringify(enriched.searchQueries),
            enriched.searchAfterDays,
            enriched.contextBlock,
            enriched.timezone,
            enriched.scheduleHourLocal,
            null,
            null,
            now,
            now
          ]
        );
      } else {
        const prefId = String(initial?.id ?? "");
        if (!prefId) {
          setSubmitError("Missing preference id.");
          setSubmitting(false);
          return;
        }

        await sqlite.run(
          `UPDATE preferences SET
            title = ?,
            locations = ?,
            board_domains = ?,
            keyword_seed = ?,
            generated_keywords = ?,
            search_queries = ?,
            search_after_days = ?,
            context_block = ?,
            timezone = ?,
            schedule_hour_local = ?,
            google_jobs_url = ?,
            resume_asset_id = ?,
            updated_at = ?
          WHERE id = ? AND user_id = ?`,
          [
            enriched.title,
            JSON.stringify(enriched.locations),
            JSON.stringify(enriched.boardDomains),
            JSON.stringify(enriched.keywordSeed),
            JSON.stringify(enriched.generatedKeywords),
            JSON.stringify(enriched.searchQueries),
            enriched.searchAfterDays,
            enriched.contextBlock,
            enriched.timezone,
            enriched.scheduleHourLocal,
            null,
            null,
            now,
            prefId,
            userId
          ]
        );
      }

      onSaved();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div
        role="dialog"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-950"
      >
        <h3 className="text-lg font-semibold">{mode === "add" ? "Add target" : "Edit target"}</h3>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <label className={lc()} htmlFor="pe-title">
              Target role title
            </label>
            <input id="pe-title" className={ic()} value={title} onChange={(ev) => setTitle(ev.target.value)} />
          </div>
          <div>
            <label className={lc()} htmlFor="pe-loc">
              Locations (one per line, e.g. Chicago, IL, US)
            </label>
            <textarea id="pe-loc" rows={3} className={ic()} value={locationsRaw} onChange={(ev) => setLocationsRaw(ev.target.value)} />
          </div>
          <div>
            <label className={lc()} htmlFor="pe-bd">
              Job boards
            </label>
            <BoardMultiSelect id="pe-bd" selectedIds={boardOptionIds} onChange={setBoardOptionIds} />
          </div>
          <div>
            <label className={lc()} htmlFor="pe-kw">
              Keyword seeds (comma-separated)
            </label>
            <input id="pe-kw" className={ic()} value={keywordSeedRaw} onChange={(ev) => setKeywordSeedRaw(ev.target.value)} />
          </div>
          {submitError ? <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p> : null}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
