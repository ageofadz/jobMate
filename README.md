# JobMate (CLI)

Local SQLite CLI dashboard: Chrome-extension Google search and discovery, scraped listings, AI-filled answers, assisted apply flow, and daily search/application metrics.

## Run

```bash
npm install
npm start
```

Optional: copy `.env.example` to `.env.local` and set `'./data'`.

On first launch, the app asks for your **profile** (name, email, location, phone, LinkedIn, preferred compensation range, work history, optional cover letter template) and stores it only on disk, then the first-time **config** step asks for Gemini keys, optional webhook, your **website**, and **skills** (SQLite). Job search uses the **Chrome extension** from the web dashboard. After setup you get a **full-screen terminal dashboard** (Ink).

## Dashboard

`npm start` builds once then runs **`node dist/jobmate.mjs`** (do not run `tsx cli/index.ts` directly — Ink’s layout stack needs that bundle).

**Sidebar:** **↑↓** moves through Home · Targets · Results · Statuses · Metrics · Config (**1–6** jump). **→** or **Enter** opens the focused page’s panel (skipped on Home).

**Panel:** **↑↓** moves lists/config rows/job queue; **↑** at the top row returns to the sidebar. **←**, **Esc**, or **Tab** toggles sidebar ↔ panel. **q** quits.

Home (**Enter/r**) starts the search pipeline in the background for enabled targets, up to 100 results per target. The progress banner stays pinned at the top while Results refreshes as new rows are inserted. Targets support **a/e/t/d** for add/edit/toggle/delete. Results shows one column per target; **Enter** opens normal Chrome with the JobMate extension, fills detected fields, and attaches files where possible, while **Backspace** archives. Statuses lets you switch archived/applied buckets, unarchive, or delete. Metrics shows retrieved/applied counts by day.

Before applying, load the local Chrome extension once: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the repo's `chrome-extension` folder.

To insert a profile row without prompts (only when `users` is empty), run `npm run seed-user` with `JOBMATE_SEED_EMAIL` and `JOBMATE_SEED_FULL_NAME` set, and optionally `JOBMATE_SEED_LOCATION`, `JOBMATE_SEED_CURRENT_LOCATION`, `JOBMATE_SEED_PHONE`, `JOBMATE_SEED_LINKEDIN_URL`, `JOBMATE_SEED_PREFERRED_COMP_RANGE`, `JOBMATE_SEED_COVER_LETTER_TEMPLATE`, `JOBMATE_SEED_WEBSITE`, `JOBMATE_SEED_WORK_HISTORY`, `JOBMATE_SEED_SKILLS`.

## SEA Binary

Build the packaged executable with:

```bash
npm run build:sea
```

That produces `dist/sea/` containing:

- `jobmate` or `jobmate.exe`
- `chrome-extension/`
- `node_modules/better-sqlite3/`

Run the packaged executable from inside `dist/sea/` so it can resolve its sibling support files.
