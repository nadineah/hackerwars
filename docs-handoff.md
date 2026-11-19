# Whimsy Web handoff (extension, Dashboard mode, community website)

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

## Design previews
- When a design is made, applied, or "Create/Refresh preview" is chosen, the extension makes a tiny blurred preview. The content script first replaces text with neutral bars and blurs images in place (no AI), the visible tab is captured and the page restored immediately, then the screenshot is shrunk to a few dozen pixels (this removes detail for good), enlarged smoothly, softly blurred and lightly sharpened. Only that ~5 KB image is stored. The full screenshot is never saved or sent. Nothing is captured in private windows. Settings has a switch and "Clear all previews".
- Tests: `tests/preview.test.ts` (rules and pixel steps) and the real-browser `scripts/e2e/previews.cjs` (needs `WW_OUTDIR=dist-e2e WHIMSYWEB_E2E=1 node build.mjs`, which adds a test-only hook that is never in `dist/`). Previews are not guaranteed anonymous: text drawn into a canvas or a closed shadow root is only covered by the shrink.

## Generated illustrations (OpenAI models only)
- A "Generate illustrations" checkbox appears next to Attach image when an OpenAI model is selected. ON: the model gets the art-director instructions and an `illustrations` field; the extension asks `gpt-image-2.5-flare` (images API) for each picture (max 4, descriptions only, nothing from the page), shrinks them to small WebP and stores each as `art:<id>`. Designs refer to them as `ww-asset-art:<id>` tokens, which the CSS sanitizer allows and the content script swaps for the real image after sanitizing. OFF: CSS-only designer instructions (which may suggest turning illustrations on). Claude models ignore the checkbox.
- Pictures are written in the same storage write as their design, and unreferenced ones are deleted after deletes. Shared community themes lose their pictures (they become blank). gpt-image-2.5-flare may need OpenAI organisation verification; if it fails the design still saves and the reply says why. Image calls are counted in Token usage under gpt-image-2.5-flare (OpenAI-reported tokens, or the documented size if none are reported).

## Whimsy Lab (prompt test bench, model-driven)
- A separate extension in `lab/` (`npm run build:lab`, load `dist-lab` unpacked). The model is given TOOLS and the user’s system prompt decides the whole workflow: `take_screenshot` (the live page as rendered, optional scroll), `apply_css` (live preview; the safety filter reports how much it kept), `generate_image` (`gpt-image-2.5-flare`; shapes, transparency, quality, `reference_ids` for style reference = earlier pictures or the current page; no count limit; needs an OpenAI key, works with any design model), `submit_design` (final; css optional = what was last applied). `lab/src/agent.ts` is only the loop (Anthropic messages tool use / OpenAI Responses, stateless with encrypted reasoning items): call the model, run the tools it asks for, return results (images included), repeat until it submits. The only guard is a stop after 200 model turns and the Stop button. The system prompt is sent exactly as typed (blank = none); how to use the tools is in the tool definitions. Whimsy Web’s own theme on the page is switched off during runs. Each result keeps every step (what the model said, each tool call, screenshots, pictures) so you can see whether planning, image generation or CSS caused a poor result. Starter prompts: Agent workflow (example), Art Director, Experimental Mode (verbatim), current Whimsy Web prompt. Its keys, prompts and results live only in its own storage.
- The main extension is unchanged (fixed one-call workflow; optional Generate illustrations).

## Readability (programmatic contrast fix, no AI)
- `src/shared/contrast.ts` (pure WCAG maths + `fixColor`) and `src/content/contrast.ts` (DOM). After a Whimsy Web design is applied, every visible piece of text is compared with the colour really behind it (parents composited over white; text over an image or gradient is only counted as unknown). Below 4.5:1 (3:1 for large text) the text colour is nudged the way it already leans: darker text darker, lighter text lighter, hue kept, smallest change that passes; if that direction can never pass (dark text on mid grey) it flips. Fixes are one stylesheet (#ww-contrast-style) plus data-ww-fix markers, never page rewrites; clearing restores the page. Re-runs (throttled) on page changes; off when the design is off or Show original. Setting: Settings > Readability (stored in the secret-free `prefs` key, default on). The This site tab shows how many colours were adjusted. The Lab has a `check_contrast` tool (report, optional live fix). Not covered: overlapping borders/clipped edges, hover states, text in canvases/videos, pseudo-element text.

## Limits
- Image URLs in sandboxed pages are allowed over https (`img-src https:`), so a script could encode that dashboard's own data in an image URL. Scripts have no access to API keys or other extension data.
- Legal pages are drafts needing owner review. Seed themes cover Wikipedia and Hacker News only (the sites verifiable here). Dashboard collection runs only while the browser is open. Nothing is pushed to GitHub yet.
