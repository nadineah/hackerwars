# WhimsyWeb

Describe a redesign. Claude generates it. It's saved locally and re-applies every visit, with no further AI calls.

## Run it

```bash
npm install
npm run build        # or: npm run dev  (rebuilds on change)
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the WhimsyWeb toolbar icon to open the side panel.
4. ⚙ Settings → paste your Anthropic API key (stored in `chrome.storage.local`, dev only).
5. Open any http(s) site (reload tabs that were open before installing), describe a look, hit **Transform**.
6. Reload the page: the design returns instantly, no API call.

After code changes: `npm run dev`, then click the reload icon on the extension card. Content-script changes also need a page refresh.

## Architecture

```
src/
  shared/      types, storage helpers, CSS/op sanitizers (used on both sides)
  background/  service worker: owns the API key + Anthropic call (forced tool use → structured design)
  content/     sync engine: applies enabled designs for location.hostname from storage;
               extracts a compact, redacted DOM outline; MutationObserver for SPAs
  sidepanel/   React UI: prompt, designs list, toggle/rename/delete/remix, before/after
```

Flow: panel → background (`ww:generate`) → asks content script for DOM outline → Claude (`submit_design` tool: `name`, `css`, `ops`) → sanitize → save to storage → content script reacts to `storage.onChanged` and applies.

**Safety model.** The model never writes JavaScript. Output is CSS plus a closed set of DOM ops
(`hide`, `setText`, `addClass`, `move`, `insert` from an allowlist of tags). CSS is sanitized
(no `@import` except Google Fonts, `url()` only https/`data:image`, no `expression`/`behavior`),
selectors are validated, and the page outline excludes form values, scripts and attributes. Sanitizers run at
generation time and again before applying. Page text is passed to the model as untrusted data.

## Known limits / next steps

- Designs are keyed by hostname (not path patterns).
- Sites with strict CSP may block Google Fonts `@import`.
- The API key lives in the extension: **before distributing, move generation behind an authenticated backend proxy** with usage caps.
- Default model is `claude-sonnet-5-5` (editable in Settings); check current model availability and pricing in Anthropic's docs.
- Not yet built: icons, token/credit tracking UI, shadow-DOM-aware extraction, design export/import, gallery.

## Scope: page vs. whole site

Each design is either **whole site** (every page on the hostname) or **this page** (one pathname; query string and hash are ignored, `/x` = `/x/`).
Pick it with the "Apply to" toggle in the chat; it can be changed later and moves the saved design. At most one design is on per *slot*
(one whole-site design plus one per page), so a site-wide theme and a page-specific design can stack, with the page design on top.
Single-page-app navigation (`pushState`/Navigation API) re-evaluates which designs apply. Designs saved before scopes existed count as whole-site.
Everything is stored locally in `chrome.storage.local` (`site:<host>` holds both kinds); there is no server yet.

## Prompt caching

Requests mark two cache breakpoints: (1) tools + static system prompt, (2) the page outline, placed at the start of the first user
message (not in the system prompt, since it is untrusted page data). Later turns in a conversation re-read that prefix at the cached rate.
Each reply shows its token usage, e.g. `4.2k in (3.1k cached) · 1.8k out`; cache reads appear only if the prefix matched
(the cache lasts ~5 minutes, and very short prefixes are below the model's minimum cacheable size).

## All sites

A design can also apply to **every website** ("All sites" in the scope toggle, or the 🌐 button on a saved design). It is stored like a
site under the pseudo-host `*` (`site:*`), stacks underneath whole-site and page designs, and is **CSS-only** (DOM ops are ignored: they
target one site's elements). Claude is told to write generic, layout-safe CSS for it. Because it can touch sites you did not expect, it
asks for confirmation, and **"Skip here"** turns it off for a single site without disabling it elsewhere.

## Providers

The selected model decides the provider: ids starting with `claude` use the Anthropic key; anything else (GPT presets or a custom id) uses
the OpenAI key (Chat Completions, forced function call, `max_completion_tokens`). Prompt building is shared; only the request and response
handling in `src/background/providers.ts` differs. Prompt-cache breakpoints are Anthropic-specific (OpenAI caches stable prefixes
automatically; the panel shows cached tokens for either). Page outlines and any attached images go to the provider of the selected model.
