# Spec: the chat follows the tab

Status: agreed 2026-11-24, implemented in the same change.

## Why

People were confused when the AI kept working on a page or tab they had already left: the Chat tab kept showing the
old chat while they looked at another site. Each chat is still paired with one theme (and that theme's version
history), but the panel now always shows the chat that belongs to the tab on screen.

## 1. Which chat a tab shows

Checked in this order, first match wins:

1. **A chat opened on purpose** for this tab (History, Library "Open chat", the "Also on this page" chip, the
   "Continue your last chat" link, a toast's "Go to tab", or the chat a message was just sent from). It holds until
   the tab moves to another site or page, or another chat is opened. A brand new tab that is still loading keeps it,
   and a redirect while loading does not cancel it.
2. **A theme is on for this page**: the chat of the most specific theme. *This page* beats *Whole site* beats
   *All sites*. Two themes at the same level: the one switched on or edited most recently. A theme with no chat is
   skipped.
3. **Nothing**: a fresh chat. If this site has an earlier chat, a small link at the top says
   "Continue your last chat for this site".

An All Sites theme skipped on this site does not count here. The chat toolbar has **Turn off** / **Turn on** for the open
chat's theme (it replaced "Show original"). Turning off really switches the theme off (an All Sites theme is skipped on
this site), and the chat stays on screen with the "This theme is off" note.

Two tabs on the same site show the same chat. "New chat" on a tab shows a fresh chat on that tab (rule 1).

## 2. Opening a chat from History or the Library

Opening a chat also brings up its tab: a tab already on that page (This page) or site (Whole site) is switched to,
otherwise the page is opened in a new tab. An All Sites chat stays on the current tab when it is a website, otherwise
the site it was made on opens.

Opening a chat never switches its theme on. If the theme is not on this page, a calm note sits above the message box:

> This theme is off on this page. Sending a message turns it back on. **[Turn it on]**

"Turn it on" applies the chat's current version (the version buttons in the chat can pick another). For an All Sites
theme skipped on this site, sending (or Turn it on) stops skipping it here.

## 3. Scope label

The scope note under "Apply to" is the size of the chat text and full contrast, with the place in bold:
"Only **youtube.com/watch**", "Every page on **youtube.com**", "**Every website**". No flashing or motion when the
chat changes.

When more than one theme applies to the page, a row at the top of the chat lists the others ("Also on this page:")
as small chips; choosing one opens its chat on this tab (rule 1). A chip whose chat is working shows a small spinner.

## 4. Jobs on several tabs

- Jobs run in the background, so several can run at once, up to **3**. At the limit, sending says so and waits.
- One chat runs one job at a time (a second tab on the same site sees "working" and a Stop button, not a second send).
- Every job remembers the tab it was started from. Its screenshot review always uses that tab.
- Working chats show a small spinner in History and in the Library (on the design's row).
- Unsent text and attached images are kept per chat, so switching tabs never loses a draft.

## 5. Toasts

Only for jobs whose tab is **not** the one on screen (if you are looking at it, the chat already shows it).

- **Done**: "✓ Done on youtube.com". Fades after 6 s (not while hovered or opened).
- **Needs you**: the screenshot review is waiting for its tab. "Come back to youtube.com to finish the review".
  Stays until dealt with. Buttons: **Go to tab**, **Skip review**.
- **Problem**: the job failed (e.g. the tab must be reloaded). Stays until dismissed.

Look: small pills in the top corner under the tabs, panel surface colour, a hairline border, soft shadow, 13 px text,
a site icon, no bright colours (a small coloured dot marks the kind). Three or more collapse into one "3 updates"
pill. Clicking a toast opens it to show the full reply text and details; it never switches tabs by itself.
**Go to tab** switches to the job's browser tab and brings its window to the front; the chat follows on its own.
If the tab was closed, the page is reopened. Toasts are announced politely to screen readers, keyboard reachable,
and never steal focus.

## 6. All Sites warning

The first time a message is sent to an All Sites chat in each panel session (closing and reopening the panel starts a
new session), an inline panel appears above the message box instead of sending:

> This changes your theme on **every website**.
> **[Send to all sites]** **[New theme for this site instead]**

The message stays in the box. Enter does not confirm; one of the buttons must be clicked. "New theme for this site
instead" starts a fresh Whole site chat on this tab with the same text. Choosing All sites for a NEW chat no longer
asks a separate question when the button is pressed (the send warning covers it). Moving an existing design to all
sites still confirms straight away, because that changes live pages immediately.

## 7. All Sites menu items

"Skip on this site" and "Stop using on all sites" are disabled (with the hint "Turn the theme on first") while the
All Sites theme is switched off. "Use on this site" (undoing a skip) always stays enabled.

## 8. Tabs the extension cannot reach

- The panel checks every tab when it is shown, instead of waiting for an action to fail.
- Tabs opened before the extension was installed or updated are attached automatically (the `scripting`
  permission; no extra install warning). A newly attached script first tells an older copy left in the page to
  stand down and removes its leftover styles, so a theme is never drawn twice.
- If attaching still fails, a bar at the top of the chat says
  "Whimsy Web can't reach this tab yet. **[Reload tab]**". It disappears by itself once the tab answers. Sending,
  screenshots and Edit Mode are disabled until then.
- Chrome's own pages, the Chrome Web Store and the PDF viewer can never be changed; they say so ("Whimsy Web can't
  change Chrome's own pages") and never ask for a reload.
- A background job that needs its tab reloaded uses a Problem toast with Go to tab.
