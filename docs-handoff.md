# WhimsyWeb handoff (extension, Dashboard mode, community website)

## Run
- Extension: `npm install && npm run build`, load `dist/` at chrome://extensions (Developer mode). `npm test` runs 14 suites; `npm run live-check` fetches the real demo dashboard sources.
- Website: `cd web && npm install && npm run db:migrate && npm run db:seed && npm run dev`.
- Env (web): `SITE_URL`, `EXTENSION_IDS` (id from chrome://extensions), `MODERATOR_EMAILS`, `DATA_DIR`, `AUTH_SECRET` (required in production), `RESEND_API_KEY` + `EMAIL_FROM` (email), `AUTH_GOOGLE_ID/SECRET` (optional), `EXTENSION_STORE_URL` (optional).
- Extension build: `WHIMSYWEB_SITE_URL` (https in production) and `WHIMSYWEB_SITE_ORIGINS` set the only origins allowed in `externally_connectable`.

## Tested
- Unit suites (all pass). Real-browser e2e: `scripts/e2e/website-extension.cjs` (browse, apply with confirmation, live restyle of Wikipedia, undo, sign-in, publish + validation, report, moderation, extension-to-website draft transfer).
- Dashboard mode e2e in real Chromium: `scripts/e2e/dashboard.cjs` (AI provider stubbed; real websites). It covers: the assistant's HTML/CSS/JS page and collect script, the approval dialog before any fetch, data from a JSON API, an RSS feed, a scraped HTML page and a JavaScript-rendered page (background tab closed afterwards), the sandbox probe (no direct network, no extension APIs), per-dashboard notes, a script blocked from an unapproved site, alarm-driven collection with every dashboard tab closed, recovery after a real browser restart, global pause, and delete.
- Not tested live: the side panel Share button (needs the real side panel) and the AI assistant (needs an API key).

## Dashboard mode design
- A dashboard is HTML + CSS + JavaScript written by the assistant, plus an optional `collect` script that pulls data from websites. Both run ONLY in a sandboxed extension page (`sandbox.html`, manifest `sandbox` CSP: no network, no extension APIs). Chrome does not allow eval/inline script in normal extension pages, so a sandbox page is the only place AI-written code can run.
- Scripts reach websites only through the bridge (`src/dashboard/bridge.ts`): approved sites only (including after redirects), no cookies, no private addresses, size/time/request caps. Pages that need JavaScript or sign-in are read through a managed background tab, only if the user approved background tabs.
- Collect scripts run on a schedule in the offscreen document with every dashboard tab closed (alarm + persisted state, backoff, recovery). Updates need the browser to be running.
- The assistant sees its own code and error messages, never collected data. It cannot grant approval.

## Limits
- Image URLs in sandboxed pages are allowed over https (`img-src https:`), so a script could encode that dashboard's own data in an image URL. Scripts have no access to API keys or other extension data.
- Legal pages are drafts needing owner review. Seed themes cover Wikipedia and Hacker News only (the sites verifiable here). Dashboard collection runs only while the browser is open. Nothing is pushed to GitHub yet.
