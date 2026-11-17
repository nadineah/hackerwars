# WhimsyWeb handoff (extension, Dashboard mode, community website)

## Run
- Extension: `npm install && npm run build`, load `dist/` at chrome://extensions (Developer mode). `npm test` runs 14 suites; `npm run live-check` fetches the real demo dashboard sources.
- Website: `cd web && npm install && npm run db:migrate && npm run db:seed && npm run dev`.
- Env (web): `SITE_URL`, `EXTENSION_IDS` (id from chrome://extensions), `MODERATOR_EMAILS`, `DATA_DIR`, `AUTH_SECRET` (required in production), `RESEND_API_KEY` + `EMAIL_FROM` (email), `AUTH_GOOGLE_ID/SECRET` (optional), `EXTENSION_STORE_URL` (optional).
- Extension build: `WHIMSYWEB_SITE_URL` (https in production) and `WHIMSYWEB_SITE_ORIGINS` set the only origins allowed in `externally_connectable`.

## Tested
- Unit suites (all pass). Real-browser e2e: `scripts/e2e/website-extension.cjs` (browse, apply with confirmation, live restyle of Wikipedia, undo, sign-in, publish + validation, report, moderation, extension-to-website draft transfer).
- Not tested live: the side panel Share button (needs the real side panel) and the AI assistant (needs an API key).

## Dashboard mode
Removed from `main` to keep the extension's permissions small for store review. The complete, tested feature is on the `dashboard` branch (tag `dashboard-v2-working`). To bring it back, merge that branch or revert the "Remove Dashboard mode" commit.

## Limits
- Image URLs in sandboxed pages are allowed over https (`img-src https:`), so a script could encode that dashboard's own data in an image URL. Scripts have no access to API keys or other extension data.
- Legal pages are drafts needing owner review. Seed themes cover Wikipedia and Hacker News only (the sites verifiable here). Dashboard collection runs only while the browser is open. Nothing is pushed to GitHub yet.
