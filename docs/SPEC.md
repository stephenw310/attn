# Product specification

Attn is a desktop Gmail client for macOS and Windows. This document defines product behavior and acceptance criteria. It does not record implementation progress.

See [README.md](../README.md) for setup, [AGENTS.md](../AGENTS.md) for development rules, and [known issues](KNOWN-ISSUES.md) for recorded product defects.

## 1. Product principles

1. Apply mail actions to the local store before network completion.
2. Make each mail action available from the keyboard and the command palette.
3. Keep one main view active. Replace the list with a conversation when the user opens it.
4. Keep cached mail and local drafts usable offline.
5. Preserve the user's selection and scroll position when they return to a view.

Section 7 defines performance budgets. These are acceptance targets, not claims about every machine or mailbox.

## 2. Scope

Attn supports these capabilities:

- Multiple Gmail accounts with separate inbox views.
- Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, and Trash views.
- Archive, restore to Inbox, snooze, trash, star, unread, spam, labels, and move.
- Bulk actions and undo.
- Rich-text composition, replies, forwards, attachments, contact autocomplete, and Gmail draft sync.
- Undo send, reusable snippets, and local follow-up reminders.
- Local full-text search and explicit Gmail search.
- Inbox splits with rules and notification settings.
- Desktop notifications, unread badges, background operation, and launch at login.
- Built-in themes, settings, and keyboard shortcut help.
- Optional AI reply drafting and separately enabled inline autocomplete.
- Personal installers and signed release builds with automatic updates.

Calendar, mobile, web, and Linux product support are outside the current scope. Outlook, IMAP, a unified inbox, scheduled send, and read tracking are also excluded.

Google Contacts import, custom send-as aliases, Gmail-native snooze, and Gmail filter administration are not supported. Contact autocomplete derives from mail headers. Gmail confidential-mode messages can contain only API placeholders.

## 3. Design decisions

### D1. Gmail provider

Gmail supplies threading, labels, history sync, and drafts through its API. Sync code uses the `MailProvider` interface. Other providers are outside the current scope.

### D2. Local operation

Attn has no hosted mail backend. It polls Gmail for new mail. The active account polls every 15 seconds in the foreground. Background accounts poll every 60 seconds.

Snooze and follow-up reminders use local timers. A reminder that becomes due while the app is closed returns on the next launch. Closing the window keeps Attn in the background by default.

AI requires explicit opt-in and a user-selected provider. Signed release builds also contact their configured update feed. Remote mail images load from sender-controlled servers according to image settings.

### D3. Desktop runtime

Electron provides the same Chromium engine on macOS and Windows. React renders the UI. TypeScript implements the UI and mail services.

### D4. Account ownership

The UI shows one account at a time. Each account owns its mail, drafts, search results, contacts, and sync state. Inactive accounts continue to poll, replay actions, send mail, and process reminders.

Account switching replaces the mail view. It does not combine mail from multiple accounts. Section F18 defines the account lifecycle.

### D5. Local storage

SQLite stores mail and local state. FTS5 indexes local search content. Historical sync stores message headers within the configured conversation limit. The default limit is 400,000 conversations.

Initial sync fetches recent Inbox bodies. Older bodies and attachment bytes download on demand. F2 defines the sync stages, limits, and recovery rules.

### D6. Layout and themes

The Tide visual direction uses quiet, palette-tinted backgrounds, readable secondary text, and the `attn:` wordmark. Built-in palettes share semantic color tokens. Secondary actions use a subtle hover fill without a resting border. Fields and shortcut keycaps retain visible boundaries.

A 190-pixel sidebar contains mailboxes and user labels. A persistent control and `Mod+B` toggle the sidebar outside the composer. The saved choice also applies to the reader. The logo hides with the sidebar; there is no compact icon rail. Mailboxes use icons and names. The flat label list uses the same colors as message label chips. System mailbox entries show their chord shortcuts on hover. Settings and split editing hide the mail sidebar without changing the saved preference.

The content area switches between the conversation list and a focused reader. New mail uses a full-window composer. Replies and forwards use an inline composer under the source conversation.

The top bar shows account controls and pending mail activity without an unread-progress meter. It leaves native window controls unobstructed. The mailbox title sits above the Inbox splits without enclosing header borders. The top-bar controls start at the expanded sidebar boundary and stay there when the sidebar closes. Write stays in the top bar outside the sidebar. The sidebar and keyboard-hint toggles sit together. The hint footer uses the page background and boxed keycaps without a contrasting panel. A columns icon directly after the last visible split opens the split-rule manager, before the overflow menu. Tab labels keep the same font weight and do not show hover tooltips. Each tab fits its label and visible unread count. Zero unread counts reserve no space; tabs resize when counts change. Settings are available from the account menu and command palette. `Mod+Shift+S` opens split rules.
Reader and new-message headers use one clickable `Esc` close control. Settings uses one Back to mail control with an `Esc` keycap.
Icon hints appear after 120 milliseconds on hover and immediately on keyboard focus. They include assigned shortcuts.

The mailbox hint bar shows Navigate, Open, Mark done, Write, Go to, Undo, and Command palette when applicable. Inbox zero reduces it to Write and Search. Reader hints retain message navigation and expand/collapse, and show Reply, Mark done, Snooze or Change snooze, and Back. At narrow widths, reader hints prioritize Reply, Mark done, Snooze, and Back. Message-navigation shortcuts remain available through All shortcuts. Settings, split rules, and full-window compose omit the global hint bar. Bulk selection shows its count and Mark done, Snooze, Label, and Clear actions above the list.

A sync error shows an inline mailbox notice with Retry and Details. Details opens the same popover as the top-right status. The status retains retry and error-copy controls. Sync details use a state-specific heading with Close below the detail text. Follow-up picker presets align left. Sync popover headings use 16px medium text; detail copy uses 11px text with 1.65 line height.

The reader header stays compact without an action toolbar or separate message-actions dialog. It omits participant names and mailbox-position counters. Snooze timing appears in the actionable banner, not again below the subject. Conversations outside Inbox, Spam, Trash, Drafts, and pending reminders show Done and their All Mail location. Trashed-message and blocked-image notices use filled panels. Message details use an unbordered grid. Search rows place sender and subject together without date-group headings. Search timestamps include the year for mail outside the current calendar year; the search header and submission controls keep their existing positions.

The signed-in window initially focuses the mail view without highlighting a toolbar button or showing its hint. Toolbar controls retain keyboard focus hints. Mailbox, label, settings, and split-rule navigation draw keyboard focus outlines inside controls so scrolling panels do not clip them. Focus alone does not change the selected destination.

`Mod` means Command on macOS and Control on Windows. Section 5 lists the default keyboard commands.

## 4. Feature specifications

### F1. Onboarding and authentication

Google sign-in uses an OAuth authorization code with PKCE. The system browser redirects to a loopback listener at `http://127.0.0.1:<port>`. Attn requests `gmail.modify`, `openid`, and `email`.

Electron `safeStorage` encrypts OAuth tokens through macOS Keychain or Windows DPAPI. The user-supplied OAuth client configuration is a separate local JSON file.

**Accounts:** the account menu and palette expose Add account. Each account has separate tokens keyed by its normalized email address. Existing single-account token files migrate to the account map on first launch. Signing in with an existing address refreshes that account's tokens. All accounts use the same OAuth client, with separate per-user quota budgets.

**Signed-out state:** the app shows the approved tidal-inlet illustration behind the centered sign-in content, with theme-specific shading for readable text. The app shows the sign-in screen without mounting mail views, subscriptions, or mail commands. The sign-in action has keyboard focus. If `oauth.config.json` is missing, the screen refers to the README setup instructions. If the authentication status request fails, the screen offers Retry.

Each user supplies a Google Cloud OAuth client. `gmail.modify` is a restricted scope. A shared public OAuth client requires a separate distribution decision. See [Google's scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes).

**Acceptance criteria**

- A fresh install reaches the first conversations within 60 seconds on a typical inbox, after OAuth setup. Metadata appears before background sync completes.
- Revoked Google access shows a reconnect prompt without a crash. Only the affected account pauses.
- Adding an account preserves the existing accounts' sync cursors.
- A signed-out launch works with the keyboard alone. Mail shortcuts do nothing in that state.

### F2 — Sync engine & offline

**Backfill:** on first sync, fetch all labels, then run checkpointed stages in priority order, newest first
within each stage, with the cursor persisted per page so a killed or offline-interrupted app resumes where
it stopped instead of restarting:

1. **inbox** — Inbox thread/message metadata (headers, snippets, label sets) for the last 12 months. The
   triage surface and its unread count are complete after this stage, whatever the user's archive habits.
2. **bodies** — full Inbox message bodies for the last 90 days.
3. **drafts** — every Gmail draft (the two-way draft sync owns the mechanism).
4. **all-mail** — metadata for the last 12 months with **no label filter**: archived, sent, and everything
   else outside Spam/Trash. Subsumes the earlier dedicated Sent stage; recent search and autocomplete are
   complete after it.
5. **spam-trash** — Spam and Trash metadata via explicit label listings (`threads.list` excludes both
   unless asked). Gmail purges both at ~30 days, so these stages are inherently small.
6. **reconcile** — authoritative per-system-label id re-lists to repair membership drift.
7. **lifetime** — a low-priority, quota-throttled, resumable header sweep with no date bound (F2).

**Sent mail and contacts have no stage of their own.** Gmail's unfiltered listing already returns SENT, so
sent mail rides the all-mail and lifetime stages — the reason the dedicated Sent stage is retired rather
than reordered. The contact index is derived, not fetched: every persisted message contributes its
recipients (when the message is SENT) or its sender (otherwise) from headers the metadata format already
carries, so header-only stages build contacts exactly as full fetches do, and messages labeled SPAM or TRASH
contribute nothing. Autocomplete therefore ramps across stages 1 → 4 → 7 rather than waiting on one pass.

Stages overlap deliberately and **skip threads already stored** instead of carving exact date complements:
Gmail's `newer_than`/`older_than` operators have coarse, fuzzy boundaries, so complement queries risk silent
seam gaps, while re-listing already-fetched ids costs ~1% of the fetch budget (per-thread gets dominate).
Skipping is safe because the history checkpoint is recorded before the first page, so the poller keeps every
stored thread current from then on. Header-only fetches carry no MIME part tree, so attachment metadata (and
the local `has:attachment`/filename search it feeds) arrives when a thread is first hydrated. Bodies older
than the 90-day window are fetched on demand and cached permanently. UI renders as soon as the first page of
inbox metadata lands.

**Storage and reconciliation:** Spam and Trash reconciliation verifies missing threads by direct fetch. It deletes a thread only after a 404 response. Listing absence alone is insufficient.

Per-message labels determine mailbox membership and reader subsets. Expired-history recovery collects complete All Mail, Spam, and Trash listings before it identifies deletion candidates. Partial listings delete nothing. SQLite and sync workers run in the utility process.

**Window rationale and completion semantics:** headers are cheap in bytes — roughly 1–2 KB — but Google's
post-May-2026 Gmail quota charges 40 units for each `threads.get` plus 10 per amortized listing page. At the
default 6,000 units/user/minute, 60k uncached thread gets therefore have a theoretical quota floor around
6.7 hours before interactive reserves, retries, and background duty-cycle pauses. That cost is accepted
because lifetime headers are what make local search recall, complete system mailboxes, and lifetime contact
autocomplete trustworthy. Bodies and attachments are orders of magnitude heavier, so only the last 90 days
of Inbox bodies are fetched eagerly; everything older hydrates on open. Stage boundaries exist only where
behavior changes, never just to slice dates: the inbox stage guarantees the triage surface first, stages
2–6 run at normal background priority, and the lifetime sweep drops to a throttled low-priority posture.
These dates define bootstrap windows; an API page size such as 500 must never become an arbitrary
"only sync 500 messages" limit. The lifetime sweep has a separate, explicit conversation limit under
F2. Older mail remains available through Gmail search and on-demand reads.

**Lifetime header sweep:** after
interactive readiness, a resumable low-priority pass walks lifetime message headers across the whole account
(no label filter, newest first), skipping threads already stored. It persists its own cursor, reports
unique locally indexed threads—including metadata written by every earlier stage—against
`getProfile().threadsTotal`, reports message context from `getProfile().messagesTotal`, and never downloads
old bodies or attachments. The durable listing count remains cursor bookkeeping rather than user-visible
progress; page-level `resultSizeEstimate` is not a mailbox total and must never be used as the denominator.
Contact statistics derive from the same header stream — recipients of Sent mail, senders of
received mail — so an address last emailed years ago autocompletes locally; messages labeled SPAM or TRASH
never contribute to contacts. While the pass runs, sync status reads **Indexing**.
Click the status for progress and quota-wait details. Importing a user's saved Google Contacts through the People API remains a
separate opt-in product decision because it adds OAuth scope and consent requirements; autocomplete must not
imply that the mail-derived index contains an address book the user has never emailed.

**Historical sync limit, F15:** each account has its own limit, defaulting to 400,000 conversations
from `LIFETIME_THREAD_CAP`. Settings and the palette offer a custom positive integer, reset to default,
and **All mail**, encoded as `0`, with a warning about disk use, quota, and app-open time. The preference
survives relaunch and Keep-local-data sign-out; Delete-local-data removes it. Changing it needs neither
a rebuild nor a sign-out. Increasing the limit resumes a capped cursor; decreasing it stops further
historical fetching at the next safe point and deletes nothing. It does not limit Inbox/recent sync,
new mail, explicit Gmail search, or on-demand reads, so it is not a hard row-count or disk-space ceiling.
Completed attachment indexing must cover headers added by a later expansion too. Other accounts, sends,
and polling keep working while the affected account's historical chain adopts the new limit.

Backfill has two distinct completion points:

1. **Interactive-ready:** the first recent page is committed and the user can read and triage local mail.
   The fresh-install target remains under 60 seconds on a typical inbox.
2. **Background index complete:** every bounded stage is exhausted and the lifetime sweep's cursor reads
   done. Its duration is proportional
   to mailbox size, Gmail's per-method quota costs, and rate-limit waits; it has no fixed five-minute SLA and
   must never make an already-usable inbox look unavailable.

A capped sweep is usable but not complete. Keep `capped:lifetime[:page-token]` and its page-start count
durable so a raised limit resumes without duplicate counting. Show capped coverage separately from
ongoing indexing and from an exhausted `done` cursor, with Gmail search available for older mail.

After interactive readiness, the top bar reports **Indexing** while mail remains usable.
The status details show **X of Y threads indexed** and time remaining, where X is the account's
unique local thread count and Y is the current profile thread total. The ETA estimates time to the local
sweep limit or the account total, whichever is smaller; disabling the limit uses the account total. No ETA
is shown once that target is reached or when the account total is unknown. The status details also expose an
explicit quota-wait state instead of appearing stuck during backoff. Split badges and OS badges retain
their unread counts; the top bar has no unread-progress meter.

**Incremental:** poll `history.list` from the last stored `historyId` (15s foreground / 60s background). Each cycle also refreshes the label catalog (`labels.list`, 1 unit): history reports label *applications*, never label create/rename/delete, so the catalog would otherwise go stale. On `historyId` expiry (HTTP 404), fall back to a delta re-list; once non-Inbox mail is cached, that recovery must also reconcile every cached system label and tombstone threads purged server-side while the app was away. Spam/Trash auto-purge otherwise leaves ghost rows. The completed account listing identifies candidates, but only a direct per-thread 404 authorizes deletion because threads can move between sequential listing scopes. All writes funnel through a single reducer so server-originated and locally-originated changes apply identically.

**Action queue:** every user action (archive, label, star, send…) is:
1. Applied to the local store immediately (optimistic).
2. Appended to a durable queue (`action_queue` table).
3. Executed against the Gmail API with retries + exponential backoff. Label operations are naturally idempotent. Send is guarded by an outbox state machine (see F6) so it executes **exactly once**.

Conflict rule: server state wins, except locally-pending actions replay on top of it.

**Sync visibility:** The top bar shows a dot and one label: Live, Checking, Syncing, Indexing, Offline, or Error. Click for progress details; the status does not show a hover tooltip. Click Error to read the full message, retry, or copy details. Status remains visible when keyboard hints are hidden.

**Acceptance criteria**
- Airplane mode: archive 20 conversations, quit the app, relaunch online → all 20 sync; none lost, none duplicated.
- Kill the app mid-sync → no corruption; next launch resumes from stored `historyId`.
- A change made in Gmail web (e.g. archive) is reflected locally within one poll interval.
- Historical-limit changes survive restart, preserve cached mail and unrelated sync cursors, and apply
  only to the selected account. Raising a cap restores attachment flags for newly indexed older mail;
  an unchanged or lower reached cap performs no additional lifetime Gmail requests.
- Losing the network mid-session flips the status to Offline while reads and triage keep working; restoring it returns to Live and drains the queue with no user action.

### F3 — Inbox list & conversation view

**List ⇄ focused conversation**: the list owns the content region while deciding. Opening a conversation replaces the list with one dedicated reading surface while the navigation sidebar stays put. Closing restores the list at the same selection and scroll position.

**Mailbox and label navigation:** everything this section describes — mailboxes, counts, user labels, splits, the list, and the reader — belongs to the active account (F18); switching accounts swaps it all at once. A left sidebar, expanded by default and completely removable with the persistent top-bar toggle, groups Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash, Outbox, and the account's user labels. Every system row shows its `G` chord on hover and an exact local conversation total, including zero; large totals use a compact visual label while exposing the exact value. The sidebar is 190px wide. Mailbox counts use a right-aligned column with 10px text. The selected destination name and count use semibold text; other counts use regular weight. The Labels heading does not show a catalog total. Each label shows its cached conversation count using the same membership rules as its local view. Counts refresh after local actions and Gmail sync. The active destination has one stable highlight. System mailboxes remain reachable from the command palette (`Go to …`) and their `G` chords. Label chips and label rows open the same local list view. Important/Other and user-defined splits are queues inside Inbox, not mailbox destinations, so a compact split strip appears above the Inbox list only when splits exist. The ordinary list begins directly below the top bar.

- Inbox = `INBOX`; Sent = `SENT`; Drafts = `DRAFT`; Starred = `STARRED`; Spam = `SPAM`; Trash = `TRASH`; Snoozed is the local reminders view from F4. Spam and Trash include a thread when any message carries the matching label. All Mail includes a thread when any message is outside `SPAM` and `TRASH`, including archived mail. A partially trashed thread therefore appears in both All Mail and Trash. Normal and All Mail readers hide spammed messages. They keep each trashed message's chronological position as a compact `This message was moved to Trash. Show message.` marker. `Show message` reveals that message only in the current reader and does not restore it or change its Gmail labels. Spam and Trash readers show only messages from the active mailbox. Draft and legacy `CHAT` messages never render as sent mail.
- Mailbox and user-label queries run entirely against the local store. Metadata sync extends beyond the current Inbox window so lifetime system and user-label membership is cached; switching a cached destination never waits on Gmail. Bodies still follow F2's on-demand policy.
- Switching destinations closes any open conversation and restores that destination's prior selection and scroll when revisited. Opening a conversation otherwise uses the same focused behavior in every message mailbox and label view. A Draft row opens its crash-safe composer draft rather than a read-only conversation.
- Triage actions immediately remove a row when it no longer matches the active mailbox. Spam and Trash are browsable but v1 still provides no permanent-delete or empty-folder action.
- Drafts merges locally composing outbox rows with cached Gmail Drafts. A local draft is discoverable offline before its first successful Gmail mirror, and multiple simultaneous drafts remain distinct.
- Outbox is a local operational view rather than a Gmail mailbox. The sidebar, top-bar pending readout, and **Go to Outbox** command open queued, sending, failed, and needs-review items; actionable rows reopen in the composer without discarding local content.

- The content-width list groups conversations under Today, Yesterday, Last 7 days, Earlier this month, then calendar-year headings so month/day timestamps on old mail stay unambiguous. It shows sender(s), subject, a 1–2 line snippet, timestamp, and chips (attachment, starred, snoozed-return, follow-up). Unread rows are visually distinct. Every mailbox and user-label view reads 100 rows initially, loads the next keyset page near the tail, and keeps fixed-height windowing with overscan over the accumulated rows. No list count is shown because a loaded-page count is not a mailbox total.
- In the list, `J`/`K` and unmodified `ArrowUp`/`ArrowDown` move the selection.
- `Enter` or clicking a row opens the **full-window conversation** at a responsive readable measure up to 896px, positioned at its newest message or restored thread-bound draft. Its header contains the subject and a clickable `Esc` control that returns to the list. It omits the queue-position counter. The newest message is expanded; older messages start as one-line summaries and their bodies (including HTML frames) are not mounted until expanded. Clicking an expanded message's header collapses it into that same summary row; clicking the summary reopens it.
- While reading, `J`/`K` opens the next/previous conversation at its newest message or restored draft; at the first conversation, `K` returns to the full-width list instead of remaining in the reader. The adjacent conversations are fetched into the local renderer cache beforehand so this usually has no loading state. Unmodified `ArrowUp`/`ArrowDown`, `Space`/`Shift+Space`, and `PageUp`/`PageDown` scroll the current conversation, while `Shift+ArrowUp`/`Shift+ArrowDown` extend the selection exactly as `Shift+J`/`Shift+K` do — the arrow aliases behave the same in the list and the reader. Modifier+key chords retain their platform/browser meaning. Keyboard handling continues after clicking recipient, attachment, or trim controls and while focus is inside an HTML-mail frame; `Enter` on a focused mail link retains its native link action. When no inline draft is open and no transient overlay consumes it first, `Esc` or Back/List returns to the full-width list from every Tab stop—including focused buttons and mail links—with selection and scroll intact.
- **Reader layout:** conversation messages use flat rows with top separators and no trailing bottom border. Expanded headers have no filled banner. The active message has a short accent line beside an outlined avatar in both expanded and collapsed states. `N` and `P` move that marker; `O` expands or collapses the active message. Expand all messages and Collapse all messages affect readable messages without revealing hidden Trash copies. These controls are also available through the command palette. Expanded messages expose Reply, Reply all, and Forward actions when no draft is open. The reader summary shows message count and current user-label chips without a participant summary. An outlined or filled star beside the subject shows the current thread star state and updates after the Star command. Back to the originating list shows an Escape keycap only when no inline draft is open. The reader hint bar shows Reply, Mark done, Snooze or Change snooze, and Back. Wide windows also show N/P and O; narrow windows hide those hints while retaining their keyboard commands. Reply, Reply all, and Forward buttons show their shortcuts on hover. Message expansion controls have no hover hints.
- **Message display:** each message card shows the sender, with the active account rendered consistently as `Me` before and after send confirmation, plus a recipient summary ("to me, Priya · cc Daniel") that expands on click to the full From/To/Cc/Bcc/Reply-To set with the full date, the body, and attachment chips (filename + size — click downloads to the OS Downloads folder and reveals the file). The actual outgoing `From` header uses the primary Gmail send-as display name so recipients see the configured identity. Bare HTTP(S) and `www.` URLs in plain text or unlinked HTML text render as external links. Quoted trails and signatures auto-collapse behind a plain-text `...` control rendered inline at the trim boundary; the control stays in place while expanding/collapsing and a second click collapses again. `Tab` always retains native focus navigation across the product. For collapsed HTML mail, the `...` control precedes links inside the mail frame in keyboard order; reaching it reveals the hidden trail without changing the reading viewport dimensions, and the next Tab continues into the mail links. Revealing a long trail makes the existing reading surface scroll instead of growing the window. Text-like HTML and fallback text use Attn's padded native reading surface. Typography, media, tables, dimensions, alignment, and layout-only CSS remain native because they do not require a white document. Meaningful inline text colors remain distinct on the native dark surface, with low-contrast hues brightened and ordinary dark foregrounds normalized to the native text color. Uncolored quoted text is dimmed so preserved answer colors remain easy to distinguish. HTML whose rendered meaning depends on the winning non-neutral background or background image keeps a light document canvas shared by its body, trim control, and attachments. Attn does not add padding inside light documents; sender-authored body padding still takes precedence. Light HTML body containers retain a 10px corner radius. Decorative markup confined to a signature does not promote the message. A real authored canvas inside a quoted trail is content and retains the light treatment, while ordinary quoted formatting does not turn every later reply white. Wide mail gets an in-frame horizontal scrollbar, and the conversation reserves its vertical scrollbar gutter so expanding content does not shift the reader. Bcc appears only on the user's own sent copies — Gmail never exposes other senders' Bcc.
- Bodies for the selected and adjacent conversations are preloaded so opening never shows a spinner.
- When the last row in a date group exits, its date heading fades in place while the mail row slides out.
- **Auto-advance:** after done/snooze/trash, selection (and the open reader) moves to the next conversation automatically (setting: next / previous / back to list).

**Acceptance criteria**
- 60fps scroll while progressively loading through the 10,000-thread performance profile; initial mailbox reads return no more than 100 rows.
- Unloaded mailboxes show a loading state rather than an empty state. Spam and Trash paging reads matching mailbox metadata without scanning all account messages or materializing message bodies.
- Opening a cached conversation renders in < 50ms; `Esc` returns instantly with scroll + selection intact.
- Auto-advance never lands on a stale (just-triaged) row.
- Every message's full recipient set is inspectable in two interactions or fewer; attachments download to the OS Downloads folder and are revealed on completion.
- Quote/signature collapsing never reduces an all-quote/all-signature message to a blank card, never hides content without a visible expander, and expanding/collapsing is instant (no network) without moving the control or remounting the HTML document.
- Opening by keyboard or pointer transfers reading keys to the conversation. `J`/`K` changes conversation, reading keys scroll, inline controls and HTML-frame focus never strand the keyboard loop, and expanding long content does not horizontally shift the reading surface.
- When the sidebar is expanded, every system mailbox and user label is visible. Collapsing it with the top-bar toggle or `Mod+B` removes the entire sidebar, preserves the active view, and survives relaunch. The view header remains visible so the current mailbox or label is unambiguous. System mailboxes remain reachable by palette and keyboard while the sidebar is closed. Every user label opens from its row or a message-list chip. A cached switch renders in < 50ms, returning restores selection/scroll, and displayed rows match local membership without a network round trip.

### F4 — Triage actions & undo

| Action | Behavior |
|---|---|
| **Mark done** (`E`) | Removes from inbox (Gmail archive). The signature triage verb. |
| **Mark not done** (`Shift+E`) | Restores the conversation to Inbox while preserving unrelated labels and status flags. |
| **Snooze / Remind later** (`H`) | Leaves the inbox now, returns at a chosen time. Picker offers presets (Later today, Tonight, Tomorrow, This weekend, Next week) + natural-language input ("thu 2pm", "in 3 days"). v1 implementation: remove `INBOX` and store the due-time in the local reminders table; at due time (or next launch) restore to inbox with a "returned" chip. Gmail web therefore sees a normal archive until return. **A new reply wakes the thread immediately** (configurable). Cross-device labeling and exact-time restoration move to the v1.5 companion script (F7). |
| **Trash** (`#`) | Moves to Gmail trash. No permanent delete anywhere in v1. |
| **Star** (`S`) | Toggles star. |
| **Unread** (`U`) | Toggles read state. |
| **Spam** (`!`) | Reports spam. |
| **Label** (`L`) | Opens label picker (search-as-you-type, add/remove). |
| **Move** (`V`) | Opens a one-shot picker for Done, Inbox, Spam, Trash, or an existing user label. In Inbox, the same picker has a separate Importance section. Move closes the picker after one choice. If the thread has a pending snooze reminder, Move cancels it. |
| **Select** (`X`) | Toggles selection; `Shift+click`/`Shift+J/K`/`Shift+↑/↓` extends. All triage verbs operate on the selection when one exists. |
| **Undo** (`Z`) | Reverses the last action — including bulk actions — from a session-scoped stack (last 50 actions). Every destructive-feeling verb is instantly reversible; this is what makes fearless triage possible. |

`L` and `V` have different jobs. `L` toggles any number of user labels and leaves the picker open. `V`
chooses one destination, applies it once, and closes the picker. The picker offers Done, Inbox, Spam, Trash,
and every user label. Gmail does not let clients apply `SENT`, so Sent is a source view but not a destination.
Done represents All Mail without a placement label.

When split Inbox is configured, `V` has a separate Importance section while viewing Inbox. It says **Mark as
important** or **Mark as not important**, and only shows an action when it changes at least one selected
thread. These are Gmail importance mutations, not split destinations. Removing `IMPORTANT` from the Important
split can reclassify a thread into any matching custom split or Other. Adding `IMPORTANT` does not promise to
move a thread if an earlier custom split still matches.

Each destination maps to one Gmail thread-label delta:

| Destination | Add | Remove |
|---|---|---|
| Done | Nothing | `INBOX`, `SPAM`, `TRASH` |
| Inbox | `INBOX` | `SPAM`, `TRASH` |
| Spam | `SPAM` | `INBOX`, `TRASH` |
| Trash | `TRASH` | `INBOX`, `SPAM` |
| User label | The chosen label | `INBOX`, `SPAM`, `TRASH` |

The Importance actions use the same optimistic update, action queue, and undo path as Move. **Mark as
important** adds `INBOX` and `IMPORTANT`, then removes `SPAM` and `TRASH`. **Mark as not important** adds
`INBOX`, then removes `IMPORTANT`, `SPAM`, and `TRASH`. The UI offers these actions only in Inbox, so the
placement deltas are normally no-ops.

From a user-label view, every destination also removes that view's label. The picker omits that label as a
destination. Move preserves unrelated user labels plus `STARRED`, `UNREAD`, `SENT`, and `IMPORTANT`, except
that **Mark as not important** removes `IMPORTANT`. Attn applies the local delta first and queues it. Attn then
calls Gmail `users.threads.modify` under the existing `gmail.modify` grant. The `!` and `#` shortcuts use the
same Spam and Trash system-label deltas, Gmail operation, optimistic cache update, and rollback path as those
Move destinations. This keeps each change atomic. Those shortcuts also cancel pending snooze reminders.
Undo reverses the applied thread-label delta and restores the prior reminder exactly; permanent-failure
recovery restores the same local snapshot. Because Gmail's thread API cannot recreate a label that was on
only some messages, undo reverses the actual thread mutation but may normalize that pre-existing partial
membership.

Move works in Inbox and its splits, All Mail, Sent, Starred, Spam, Trash, user-label views, and matching
search results. It also works in a reader opened from those views. A move that changes the current view's
membership removes the row and advances the selection or reader. A move that keeps the membership leaves
the row selected. Drafts, Snoozed, and Outbox keep their dedicated actions. A pending-snooze thread can still
appear in another view. Moving that thread cancels its reminder in the same local transaction as the label
change, so its due time cannot add `INBOX` again. Undo restores the reminder and reverses the applied
thread-label delta.

Bare-letter shortcuts do not also accept their shifted variants: `Shift+letter` is reserved for explicit
combinations such as `Shift+J/K`. Printable symbols that require Shift, including `#` and `!`, are unaffected.

The Done action confirmation says `Marked done`.

**Acceptance criteria**
- Any triage action gives visual feedback in < 16ms (optimistic), including on selections of 100+ conversations.
- `Z` fully reverses a bulk archive of 100 conversations, locally and (after sync) server-side.
- `V` moves a bulk selection with one destination choice, and one `Z` reverses every applied thread-label
  delta. For labels that were wholly present or absent, this restores the prior `INBOX` and user-label
  membership. If a target had a pending snooze reminder, Move cancels it and the same `Z` restores its prior
  state and due time.
- Marking a thread important or not important updates `IMPORTANT` through Gmail. Moving into or out of Spam
  and Trash updates `SPAM` or `TRASH` through Gmail. The optimistic row membership matches the chosen action.
- The reader banner shows the snooze deadline in every mailbox, label, and search view. It offers Change snooze and Return to Inbox now. Snoozed list items also show the clock, and their footer identifies H as Change snooze.
- A snoozed thread returns within 60s of its due time while the app runs, or immediately on next launch if it was closed; a reply during snooze surfaces it immediately.
- Snoozed threads are findable in the local "Snoozed" view (`G` then `H`) while the Attn profile exists. Reinstall durability and cross-device visibility are not v1 promises (decision #6).

Resolved snooze dates include the year. Dates without a year resolve to their next occurrence. Snooze confirmation rejects deadlines that have passed, including while the picker is open. The service validates the deadline before changing mail.

### F5 — Command palette

`Mod+K` opens the palette from anywhere. It is the app's primary control surface:

- Fuzzy-matches every registered command: triage verbs with arguments ("Remind me tomorrow 9am"), navigation ("Go to Sent"), settings ("Switch theme"), snippets ("Snippet: intro").
- Parameterized commands accept inline arguments with natural-language parsing where applicable (snooze and reminder times).
- Each result shows its keyboard shortcut with spaces between keys, without plus separators. macOS uses modifier symbols. The palette has a Close/Esc control and boxed navigation hints. Tab cycles between its search field and Close button.
- Ranking: exact prefix > fuzzy score, with recently/frequently used commands boosted.
- **Engineering rule:** every user-facing feature must register a palette command. No feature ships reachable only by mouse.

The keyboard reference uses grouped columns and includes shortcuts from the shared definitions even when their reader, composer, or outbox view is not mounted. Registered commands supply current labels and dynamic additions. The reference scrolls at smaller window sizes.

Label, move, and snooze pickers share a title, Close/Esc control, and boxed navigation hints. Labels retain colors and mixed selection. Invalid snooze input explains the required time format.

The shortcut footer is a context-aware guide. A persistent top-bar control, `Mod+Shift+B`, and the command palette show or hide
the keyboard hints. The hint bar is visible by default. It sits below the right-hand content pane. The sidebar extends to the bottom of the window. Sync status stays visible beside the account menu when hints are hidden. The saved choice applies across mail views and survives
relaunch. It shows commands relevant to the active view and wraps at narrow widths. Footer hints are explicit command
metadata, not automatic ranking. They favor frequent or view-defining actions, appear only while that
command is registered, and group equivalent keys under one label. The main list shows `J/K` Navigate, `Enter` Open, `E` Mark done, `C` Write, `Z` Undo,
`Mod+K` Command palette, and `G` Go to. Snoozed also shows `H` Snooze or Change snooze.
Pressing a chord prefix such as `G` temporarily replaces the hints with the visible completions from the
same command registry. The guide shows only the completion keys and labels, without repeating the prefix.
Fixed mailboxes use
`I/A/T/D/S/H/P/R/O`. Inbox splits remain in the command palette and use `Tab` or `Shift+Tab` for direct
navigation. The guide remains visible until completion, `Esc`, a view change, or a 3-second timeout. The
command palette (`Mod+K`) and cheat sheet (`Mod+/`) remain the exhaustive discovery surfaces. Narrow windows
wrap the hints onto additional rows. The footer grows to fit them without horizontal scrolling.

**Acceptance criteria**
- Opens in < 50ms; results re-rank per keystroke in < 30ms.
- Every spec'd feature in this document is invocable from the palette.

### F6 — Compose, send & undo send

`C` opens new mail in a **full-window focused surface** with a centered 800–900px writing measure. The prior
list or conversation remains mounted but hidden so its selection and scroll are restored exactly when `Esc`
or the visible Esc control saves and closes the draft. From a mail list, `R` or `F` opens the selected
conversation directly into its inline reply or forward composer. In the reader, `N`/`P` moves a visible
message cursor without expanding the message, and `O` expands or collapses it. Clicking a message also
selects it. `Enter` opens a selected collapsed message, like `O`; on an already expanded message it opens
Reply all. `R`/`A`/`F` immediately replies, replies-all, or forwards the selected message and expands it, with
the inline composer attached directly beneath that message. Later messages stay below the composer.
Quoted history sits behind a compact inline
`...` control. Text-like source mail inherits the composer surface instead of introducing a separate panel,
normalizing sender-supplied dark foreground colours for contrast, while presentation HTML retains the same
light document canvas and safe HTML structure used by the reader.
Message cards have no reply-action footer. A muted, rounded cursor marks the selection without an accent outline.
The palette exposes **Reply to this message**, **Reply all to this message**, and **Forward this message**,
using the same selected message as the reader shortcuts. From the list, reply and forward keep their default source selection.
An explicit message action uses that message's recipients, quote, attachments, and threading headers, even
after a forward and a colleague's response. Replying to a sent message addresses its original recipients.
Draft reuse matches the source message as well as the thread and reply/forward kind. Upgrading an existing
reply to Reply all keeps its original source. Close the current composer before starting another message's
draft; those commands are unavailable while composing, so unsaved content cannot be replaced.
Opening a conversation with an existing thread-bound draft reopens its newest draft beneath its saved source,
selecting and expanding that message. If the source is no longer available, the draft appears at the end of
the conversation. Loading or refreshing the conversation never remounts the composer or loses unsaved edits.
New incoming messages do not move the message cursor away from what the user is reading.
Inline drafts align with the source message body and use horizontal boundaries without a surrounding card. A Reply draft or Forward draft heading, Not sent marker, and live save state identify unsent content. The message cursor is a short accent line beside the source avatar.
Full-screen compose hides the sidebar and hint-bar toggles while keeping sync status visible.
The reminder control uses a bell icon. Its popup shows the heading Remind me if no reply and left-aligned presets. It renders above the composer without clipping.
Dedicated and inline composers share recipient chips, flat envelope rows, and a Send-first footer with Aa, attachment, and reminder controls. The dedicated composer has no enclosing card or shadow. Save state appears beside its footer actions; inline drafts keep it in their header. Attachment chips follow the authored body and signature inside the scrollable editor area. Attachment mutations show progress and retain a retryable error beside the chips. Draft rows include body previews and saved timestamps. Outbox rows show send state, errors, and an explicit reopen action; reviewing an uncertain send never sends it automatically.

Selecting editable body text shows a floating formatting toolbar. Aa and the Show formatting toolbar command expose the same controls without a text selection. Formatting retains the editor selection and undo history. The toolbar excludes collapsed signatures, the Attn footer, and opaque imported content, stays within the visible editor width, and closes independently with Escape. AI drafting shows a centered rounded Drafting reply... pill with a Stop button and Esc keycap, then a refine field. The reply invitation uses quiet inline text. Generation status uses a ground-colored floating pill with a subtle border and shadow at the bottom center of the editor. After 1.2 seconds without editing, a nonempty draft shows Continue draft with AI if no autocomplete suggestion, generation, or refinement is visible. The invitation is a non-clickable placeholder at the collapsed caret at the end of an authored paragraph. Later authored paragraphs do not suppress the invitation. Hide it inside existing paragraph text or protected signatures and footers, when the editor loses focus, or when the user selects text. Mod+J invokes the existing AI draft command and preserves authored text. AI invitations, drafting status, and refine controls overlay the editor without changing its size or moving the sending controls. Snippet menus share the application menu styling.

Recipient chips display names followed by email addresses in angle brackets. Empty subjects display as `(no subject)` in lists and readers, without modifying the stored subject. Sending a blank or whitespace-only subject requires a Send without subject confirmation for both the button and keyboard command. Keep editing and Escape cancel the send. Mod+Enter confirms Send without subject. Both actions display keycaps. Envelope errors and informational notices appear above the subject.

Inline replies initially show a compact recipient summary. Clicking it exposes recipient editing; Cc/Bcc also exposes the copy fields. Collapsing the envelope commits pending addresses. If any address is invalid or incomplete, the fields stay expanded and retain the input. The inline envelope and footer have no internal dividers. Formatting opens with `Mod+Shift+F`; bulleted and numbered lists use `Mod+Shift+8` and `Mod+Shift+7`. Individual Bold hints do not appear in the composer footer.

The inline composer's Save & close button and `Esc` save and close the draft, then restore focus to the reader at its source message. Back to the originating list is hidden while replying. A second `Esc` returns to that list. Attachment mutations, invalid recipients, and save errors still prevent closing. The inline close control shows the sole visible Escape keycap. Thread-bound drafts opened from Drafts
return to this same inline context whenever the parent conversation is locally available. A full-window composer hides the global mail shortcut footer. An inline draft keeps that footer with composer hints, while its own action footer remains inside the draft.

- **From identity:** every draft belongs to exactly one account, and its read-only From field shows that
  account. New mail binds to the account active when the composer opened; replies, reply-alls, and forwards
  always bind to the account that owns the source thread, whatever account is active. Reassigning a draft's
  account and Gmail send-as aliases remain unsupported in v1 — to write from another account, switch
  accounts first (F18, F18).
- **Gmail signature:** Attn caches the primary send-as signature under the existing `gmail.modify` grant and
  inserts it as editable content when a new-message, reply, reply-all, or forward draft opens. The cache
  refreshes at sync start and once per poll cycle, so compose never waits on the network and the last
  fetched signature remains available offline. A composer that still contains only its planned fields and
  this signature is untouched. Closing it discards the row, and the draft mirror skips it. That decision
  uses the signature applied to the draft rather than the latest account cache. A Gmail setting change
  therefore cannot turn an older untouched signature into authored content. Gmail does not expose its
  separate reply and forward signature-default choices or the checkbox that removes the `-- ` separator
  through this resource. Attn uses the primary signature for every local composer and does not invent a
  separator absent from that HTML. A signature already present in an imported Gmail draft remains
  editable and round-trips with that draft. An adjacent Gmail-marked separator collapses with the signature
  in Attn, but exports before it with one line break, retaining its trailing space in plain text.
  In dark palettes, near-black signature foregrounds are normalized for composer display while authored
  HTML, font choices, and link colours remain unchanged in the saved and sent draft.
  Empty editor lines following Gmail's quoted history do not move that history into the editable body or
  trigger a read-only formatting warning. The lines remain in the saved quote. Authored text, images, and
  styled blocks below a quote stay in their original position.
- **Attn signature footer:** an optional `Sent with Attn` line follows the account's Gmail
  signature, or the authored body when no signature exists, before any quoted history. The setting is
  on by default and applies per account to newly created local drafts in every composer mode. Show the
  line as editable content before sending, with no link, image, or tracking. Users can edit or delete it
  for an individual message without changing the account preference.
  Insert it once when creating the draft, never during send or retry. Reopening a local draft, importing
  a Gmail draft, changing settings, or undoing a send does not insert or restore the footer. Preserve any
  existing footer as ordinary draft content; never change the account's Gmail signature setting. If the
  cached Gmail signature already contains the same standalone line, do not append another. Quoted
  footers do not count as the current message's footer and remain unchanged.
  The applied Gmail signature and footer together follow the untouched-draft rule above. Default content
  alone must not retain a draft or trigger a Gmail checkpoint, even if the account preference later changes.
  Once edited, the draft's visible footer follows normal autosave, mirroring, undo, and HTML/plain-text
  send behavior. AI reply generation and refinement preserve it outside the generated region;
  autocomplete excludes the signature and footer from requests and suggestions.
- **Recipient autocomplete** ranked by interaction frequency + recency, built locally from synced sent mail. First suggestion accepted with `Tab`/`Enter`.
- At the start of an otherwise empty body, typing `Hi`, `Hello`, or `Hey` immediately offers the primary
  recipient's first display name as a gray continuation. This greeting completion is deterministic and
  local: it never calls an AI provider, needs no AI consent, and accepts or dismisses with the same
  body-owned `Tab`/`Esc` behavior as inline AI autocomplete.
- **Rich text:** bold/italic/underline/strikethrough, bulleted & numbered lists, links, blockquote, **inline images, tables, font family and size, text and background colour, and alignment** — Gmail's own authoring surface. Composer links, including links imported with a Gmail signature, open externally on click without navigating the Attn window. Pasting an image into the body is supported and travels as a `cid:` inline part. Heading levels are deliberately out: Gmail's composer has none, so they would be a superset rather than parity.
- Rich paste normalizes clipboard HTML from Notes, Google Docs, Notion, and other editors into editable email content. Preserve emphasis, links, blank lines, lists, nesting, numbering, tables, images, text colors, highlights, font sizes, and alignment. Expand simple Cocoa text, list, and table stylesheets. Remove inert editor metadata and the normal-weight Google Docs wrapper.
- Convert pasted headings to sized, bold paragraphs, code to monospace text, and checklists to checked/unchecked symbols, including literal `[ ]` and `[x]` prefixes on list items. Expand toggles into readable content. Convert supported embedded media URLs to links. Remove an image the clipboard names but does not carry, such as a Notion `attachment:` reference, and show one notice that asks the user to drag the image files in. Drop unrecognized stylesheets and keep their markup editable. A stylesheet that generates content pastes as plain text, preferably from the clipboard text representation. Do not emulate generated content, responsive CSS, or pseudo-elements. Unsupported inline layouts keep the existing sanitized preservation path; visual fidelity is not guaranteed. Clipboard normalization runs only on paste. Opening a stored draft or Gmail import keeps the formatting it had, editable as before.
- `Mod+Shift+V` in the message body and the Paste without formatting palette command insert clipboard text using the current text style. In recipient and subject fields, preserve native paste behavior. Keep line breaks and insert markup characters literally. Clear formatting in the formatting menu and palette removes selected text styling and links while preserving text and block structure. A collapsed selection clears the style for subsequent typing. Both operations support undo.
- Saved and sent tables carry the composer's cell borders and padding as literal styles, with collapsed borders. Save a column width only when the source set one, so a table reopens and arrives at its natural width.
- **Zero formatting loss is an invariant, not an aspiration.** Content Attn's editor cannot represent is preserved byte-for-byte rather than dropped: it renders in place, is not editable inline, and round-trips unchanged through save, Gmail Drafts sync, and send. No draft ever loses formatting by being opened in Attn.
- **Attachments:** drag-and-drop or picker, up to Gmail's 25MB limit, with progress indication. Attached files are copied into a local spool immediately, so a draft is self-contained even if the original file moves or the app force-quits, and that spool remains the source of the bytes for the rest of the draft's life. A forward starts with the source message's file attachments as well as its quoted inline images; the user may remove forwarded files before sending.
- **Drafts:** autosaved to the local store one second after typing stops, and at least every five seconds while typing continues, so a force-quit loses at most five seconds of work. The **Gmail Drafts mirror is a separate, slower schedule** — debounced three seconds after typing stops, skipped entirely when nothing changed since the last push — so a composing session produces a handful of `drafts.update` calls rather than one per second. Drafts are listed in the Drafts view (`G` `D`) and reopenable, and thread-bound drafts are marked on their conversation row. A reply or forward the user never contributed to is **discarded on close, not saved**, matching Gmail: its quote, planned recipients and `Re:`/`Fwd:` subject are Attn's own work, so an untouched one leaves no draft row, no conversation mark, and nothing to mirror. Anything the plan does not write — a body, an attached file, a `Bcc`, a recipient on a forward — makes it the user's and keeps it. Attn's message-specific reply/reply-all entry points share one local reply slot and its forward entry point shares one local forward slot per source message; separately identified Gmail drafts remain distinct even when several belong to the same conversation.
- **Draft sync is two-way:** drafts written or edited in Gmail appear and open in Attn, and Attn's edits flow back. Conflicts resolve last-write-wins, except that a draft open in the composer always wins over a remote change.
- **A round trip keeps the body and the quoted trail apart:** Gmail stores a draft as one document, so a reply or forward returns with its quote joined to the body. Attn separates them again on reimport by recognizing the trailing quote structurally — never by matching bytes, since Gmail rewrites markup. Reopening therefore shows the same collapsed quote it showed before the round trip, rather than loading quoted mail into the editor as authored content. Attn declines to split when authored or styled content follows the quote, because reassembly always puts the quote last; such a draft stays merged. Blank editor lines may follow a quote, including outside nested wrappers, and remain with the quoted trail. Empty lines before those wrappers remain with the authored body.
- **A mirrored draft is complete:** attachments mirror with the body, so a draft composed in Attn can be opened and **sent from Gmail web or mobile** with its files intact. Because Gmail replaces a draft wholesale, each checkpoint re-sends every attachment byte; the mirror interval therefore lengthens once a draft carries meaningful payload, while attaching or removing a file still pushes on the normal interval. Bytes stream from the local spool rather than being held in memory, and a file that Gmail echoes back is recognized as the one already held locally rather than stored a second time.
- **Send:** `Mod+Enter`.
- **Undo send:** sending holds the message in a local outbox for a configurable delay (0/**5**/8/10/20/30s, default 5). A queued reply or forward closes the composer and appears in its conversation immediately, without waiting for either the send deadline or a sync poll; that newest message is expanded by default. A toast shows the remaining seconds until sending, stays visible for the entire window, and counts down the durable send deadline with a progress bar. Its Undo button invokes the same action as Z. The button is unavailable while another draft or modal owns input. Undo removes the queued message from the conversation and reopens the composer with everything intact. The API call happens only after the window elapses.
- Outbox state machine (`composing → queued → sending → sent`) guarantees exactly-once send across crashes: on relaunch, `sending`-state items are verified against the server before any retry.

**Acceptance criteria**
- Composer opens in < 50ms; typing latency is imperceptible (< 16ms/keystroke).
- Force-quit mid-compose → draft fully recovers on relaunch.
- Undo within the window always succeeds; the message never reaches the network before the window closes.
- Queued replies and forwards appear expanded in the conversation immediately; undo removes that projection and restores the composer beneath its source message.
- No scenario produces a duplicate send.
- The optional footer appears once in new mail, replies, reply-all, and forwards, with independent
  account preferences. Its edits or removal survive save, relaunch, Gmail round trips, and undo send.
  An untouched signature/footer-only draft is discarded on close and never mirrored.

### F7. Scheduled send

Scheduled send is outside the current scope. Attn cannot guarantee delivery while the computer is asleep or off. Undo send in F6 is a short local cancellation delay, not a scheduled-send service.

### F8 — Snippets

Named, reusable text blocks inserted into the composer via palette ("Snippet: …") or a `;shortcut` text trigger typed inline. A snippet may define body text (with an optional `{cursor}` placement marker) and optionally a subject. Managed in Settings.

**Acceptance criteria**
- Insertion < 50ms; `{cursor}` lands the caret correctly; `;trigger` expansion is undoable with one `Mod+Z`.

### F9 — Follow-up reminders

When sending, optionally set "remind me if no reply" (composer control or palette: 3 days / 1 week / custom). If no reply arrives by the deadline, the thread resurfaces at the top of the inbox with a **Follow up** chip. Any reply cancels the reminder. Cancel a pending follow-up from its reader banner or the Cancel follow-up command. Undo restores it unless a later reply has answered it. Cancellation preserves mail labels and any snooze. Pending follow-ups are listed in the Snoozed/Reminders view. Their deadline also appears in Sent, other lists, and the reader. The reader explains that a pending follow-up waits for a reply. A returned follow-up displays “No reply yet. This conversation returned for follow-up.”

The sent message that created the reminder does not cancel it. A subsequent reply from any participant,
including the user, does. The reminder retains its originating message identity and date independently of
outbox retention. Replies discovered through history-expiry recovery cancel it just as incremental history
does; unresolved origin reads or incomplete recovery do not establish that no reply arrived.

A pending snooze postpones follow-up resurfacing until the snooze returns. If both deadlines have passed,
the thread returns once, with no pending snooze left to hide it on the next sync. A qualifying reply still
cancels the follow-up and follows F4's snooze-wake rules. Archive and Move complete returned follow-ups and
cancel overdue follow-ups waiting for a snooze; ordinary archive preserves future follow-ups. Spam and
Trash cancel follow-ups. Snoozing a returned follow-up postpones it to the new snooze return. Undo restores
the reminder states affected by triage.

**Acceptance criteria**
- Reply from any participant cancels the reminder within one poll interval.
- The originating sent message and replayed older history never cancel a newer follow-up.
- History-expiry recovery detects replies in authoritative snapshots before permitting new follow-up returns.
- Coexisting snooze and follow-up deadlines produce one stable return, including after relaunch.
- Resurfaced threads are visually distinct and sort above normal mail.

### F10 — Instant search

`/` focuses search. Queries run **entirely locally** against SQLite FTS5 (from, to, subject, body, attachment filenames) with results as you type.

- Operators: `from:`, `to:`, `subject:`, `in:` (label/view), `is:unread|starred|snoozed`, `has:attachment`, `before:`/`after:`.
- Result rows open straight into the conversation; `Esc` returns to the result list, then to the inbox.
- Search is scoped to the active account — the local FTS query and the Enter-submitted Gmail query alike.
  Cross-account search is out of v1 (F18).
- Local coverage follows the store: header fields match lifetime mail once the sweep completes; body terms and filenames match only hydrated mail, while `has:attachment` matches lifetime-wide once the ids-only attachment pass that follows the sweep has run under F2. Local results update as the user types. Gmail search status and local coverage share one compact area directly below the search bar without separate divider rows. Enter submits the same query to Gmail (`q=`) once and moves focus to the results; a passive row reports remote progress and failures. Threads fetched from Gmail persist through the normal write path and stay cached. Gmail search is unavailable for Drafts and snooze queries because those are backed by Attn's local outbox and reminder state rather than Gmail search state.
- At large scale, text search considers a bounded recent-match window before filters, and the footer
  identifies partial results. Explicit snooze queries keep older local matches because Gmail cannot
  search local reminder state. A historical sync cap is a separate coverage limit; changing it neither
  removes the search window nor promises exhaustive local results. Search and sync settings explain both
  limits and retain the **Search all of Gmail** action where supported (F2).

**Acceptance criteria**
- p95 < 100ms for local queries on a 50,000-message store.
- Operators combine (e.g. `from:acme.com has:attachment after:2026-01-01`).

### F11 — Split inbox

The inbox is divided into **splits** — tabs above the list, each an independently triaged queue:

- Base splits: **Important** (Gmail's `IMPORTANT` label) and **Other**.
- The first split setup also creates **Calendar**, **GitHub**, and **Newsletters** from starter presets.
  Calendar matches known calendar-notification senders, locally stored `.ics` attachments, or a cached
  `text/calendar` MIME part. GitHub matches the `github.com` sender domain. Newsletters matches messages with
  a `List-Id` or Gmail's Promotions label.
- Starter presets become user-owned rules after setup. Users can rename them, change their conditions,
  reorder them with leading drag handles, or delete them. During a pointer drag, the row follows the pointer,
  nearby rows rearrange immediately, and release chooses the nearest position. A focused drag handle also
  accepts Up and Down for keyboard access. Attn never recreates a changed or deleted preset during launch,
  sync, or an app update. The rule manager can restore a preset only after an explicit user action.
- The split-rule manager keeps the sortable list beside the selected rule editor. It identifies the current account and explains first-match ordering. Important and Other show their built-in behavior and notification preference. Custom rules expose their existing conditions, notification preference, save, and delete actions. The manager selects the first rule on opening. Escape closes it in one step, except during a drag.
- A split expression combines conditions with **any** or **all**. Conditions match a sender address, a sender
  domain, an exact `List-Id`, `List-Id` presence, a label, an attachment MIME type, or an attachment filename
  suffix. A thread matches when at least one message satisfies the whole expression. Under **all**, the same
  message must satisfy every condition. First matching split wins in the user's configured order. **Other**
  is the final fallback and cannot move ahead of a matching split, so every Inbox thread appears exactly
  once. Splits are views, so splitting never moves mail.
- Navigate: `Tab` moves to the next split, and `Shift+Tab` moves to the previous split. Navigation wraps at
  both ends. Outside Inbox, `Tab` returns to Inbox. `←` and `→` remain split-navigation aliases. Each split
  keeps its own selection and exact local unread count, and the context-aware shortcut footer shows the valid
  digit completions while the `G` chord is active.
- **Strip scaling (D6):** when splits exist, they render as a horizontal strip above the Inbox list. Hot splits show unread counts, cold ones stay quiet, and past ~8 the strip scrolls with overflow behind `···`. The full jump-list lives in the palette ("Go to: <split>"). No strip renders for an unsplit Inbox.
- Per-split notification settings (see F12): by default only Important notifies.

**Acceptance criteria**
- Split switch < 50ms with selection preserved per split. Attn warms inactive first pages after startup. A
  revision-valid cached page becomes visible in the same state transition as its tab and then revalidates
  against SQLite. An unresolved cold page shows a loading state; it never reports `Inbox empty` before the
  query completes.
- Rule changes re-bucket the inbox in < 1s for 10k threads, with no thread appearing in two splits.
- Users can edit or delete every starter preset. A changed or deleted preset stays changed or deleted after
  relaunch, sync, and an app update. Deleting all starter presets does not seed them again. Users can restore
  each preset explicitly.

### F12 — Notifications & badging

- Native OS notifications (macOS Notification Center / Windows toast) for new mail in notification-enabled splits: sender + subject, without a message-body preview. Click opens the thread in its current mailbox, including All Mail after archive and Spam or Trash after a move. If the thread is no longer stored, the click leaves the Inbox list open.
- **Batching:** a poll cycle delivering more than 3 new conversations collapses into one summary notification ("7 new conversations") instead of a burst of toasts. A summary names no single thread, so clicking it raises the window on the inbox rather than opening a conversation — only per-message notifications carry a thread target. Notifications are suppressed entirely while a window is focused.
- Unread badge: native numeric macOS Dock badge; a large red numeric Windows taskbar overlay that shows
  `1`–`9` and then `9+`, while its accessible description carries the exact count. The underlying count
  includes only notification-enabled
  splits (i.e., the number that matters, not all mail), summed across every signed-in account (F18). An
  app-wide setting, also available from the palette, can hide either OS badge without changing notification
  delivery, split settings, or background sync.
- **Multi-account (F18):** notifications cover every signed-in account, not just the active one. With more than one account signed in, the notification names the owning account; batching applies per account per poll cycle; and clicking a notification switches to that account before opening its thread (or its inbox, for summaries).
- Pause notifications for one hour or until tomorrow, or resume, from settings and the palette on either
  OS. The existing tray actions use the same app-wide deadline. Pausing suppresses notifications for all
  accounts without changing their split settings, unread badges, or background sync.
- Notification latency is bounded by polling: ≤ ~30s foregrounded (D2).
- **Without splits:** notifications and the badge cover every unread Inbox conversation. F11 defines filtering when splits exist.

### F13 — Inbox zero

When a split reaches zero, the list pane is replaced by a full-pane zero state: a rotating background image, a short affirmation, the time, and a hint of remaining splits with total conversation counts ("Other: 12 total"). Split-strip badges continue to show unread counts. Reaching zero should feel like a reward.

### F14 — Themes

Attn ships Matcha, Mist, Linen, and Dusk color palettes. Matcha is the default for existing and new profiles.
The app-wide palette preference is independent of System, Light, and Dark appearance. System follows the OS.
Both preferences persist across restart and account switches. Color palettes are available in Appearance settings
and command-palette commands. The account menu offers only System, Light, and Dark appearance, not color palettes.
Appearance settings also provide these appearance choices. Existing saved appearance preferences remain valid.
Saved Midnight resolves to Dark; saved Sand resolves to Light. Invalid or absent color palette values resolve to Matcha.

All app text tokens meet normal-text AA contrast on the page, elevated panel, and selection backgrounds.
Primary actions use the palette accent with a contrasting foreground. Secondary text remains readable in dark mode.
Message rows show labels as tinted chips, a separate star slot, and a checkmark for Done in All Mail.
Rows retain state markers for snooze, returned mail, and follow-up alongside labels. Initial loading uses a static
skeleton with a loading announcement. Cached mail remains usable during sync errors and offline operation.

Scrollbars use narrow, rounded thumbs, transparent tracks, and theme-specific normal and hover colors.
The same styling covers app panes, controls, and mail frames. Light sender canvases retain light scrollbars.

All UI, including rendered HTML mail, must be legible in every palette. Light palettes evaluate color-scheme
rules as light and preserve sender foreground and non-neutral canvas colors. Native mail clears neutral
background patches so its text sits on the selected palette, while constrained sender-designed canvases are
centered on a solid light mail surface. Dark palettes keep the safe background
normalization that `mailSurface.ts` applies today, with a per-message "View original" escape hatch.

### F15 — Settings

Settings uses a left navigation list and one content panel. All accounts groups app-wide preferences. Current account identifies the owning email and groups Sync & storage and Signature. Connections contains Accounts. Existing palette commands open the relevant panel. Settings and split rules hide mail controls while retaining status and the profile menu. Appearance offers palette swatches. The profile menu does not repeat the palette picker. Snippets remain in Settings, with search, message previews, and an inline editor.

Settings and the palette expose:

- Accounts: live sync status, add, reconnect, Sign out with Delete/Keep local data, and reorder for
  `Mod+1..9` (F18). Reuse the existing account-management guards and deletion-failure warning.
- Sync & storage: the active account's historical conversation limit, with default, custom, and All mail
  choices (F2). This control does not evict cached mail or change body windows and search limits.
- Triage: undo-send delay and auto-advance direction.
- Compose: per-account **Include "Sent with Attn"**, on by default, with a preview and a note that the
  choice affects new drafts only (F6). The palette offers the same enable/disable action.
- Notifications: one app-wide pause/resume deadline and an app-wide unread-badge toggle for the macOS
  Dock / Windows taskbar. Per-account split notification controls live in the Inbox header's split-rule
  manager.
- Snippet manager and theme. The split-rule manager opens from its columns icon beside the Inbox splits.
- Background behavior: launch at login and the macOS menu-bar icon while the window is open (F16).
- AI writing: enable, provider and key, voice profile, and separate autocomplete opt-in (F17).
- Keyboard cheat sheet (`Mod+/`).

Label account-specific controls with the owning email; other preferences apply app-wide. Settings reuse
the existing default constants and typed APIs. Internal polling, quota, paging, retry, search-window, and
editor-timing constants remain development tuning rather than user controls.

**Entry point (D6):** the account chip in the top bar is the menu — the signed-in accounts with the active one marked (F18), Add account…, Settings (`Mod+,`), Keyboard shortcuts (`Mod+/`), Sign out. Split-rule configuration opens from the columns icon immediately after the Inbox splits; its ellipsis appears only to navigate genuinely hidden splits. No hamburger icon; every item is also a palette command.

### F16 — Background & tray behavior

The app is present whenever the machine is awake, so snooze timers, polling, and notifications keep working (D2):

- **Windows:** closing the window hides to the system tray. The tray icon is always present while running; its menu offers Open Inbox, Compose, Pause notifications (1h / until tomorrow), Quit. Double-click reopens the window.
- **macOS:** the close button and `Cmd+W` hide the window and remove Attn from the Dock and `Cmd+Tab`. Attn keeps running with a menu-bar icon. **Open Inbox**, app activation, and notification clicks restore the same window and Dock icon. The menu-bar setting controls visibility while the window is open, and defaults to off. The icon always appears while Attn runs with its window closed, including launch at login. `Cmd+Q` and menu **Quit** exit fully.
- The command palette offers **Close window and keep Attn running** on both platforms.
- **Launch at login** (default on) starts the app in the background — no window flash; the window appears on demand.
- While backgrounded: polling at the 60s cadence, notifications fire, badges update.

**Acceptance criteria**
- Closing the window never stops snooze timers, polling, or notifications.
- On macOS, closing and reopening preserves the open draft and view. The Dock icon returns when the window reopens.
- Reopening clears focus from the sidebar and hint-bar toggles. Tab can focus them again. Draft and search inputs retain focus.
- A close immediately after reopening can take about one second to remove the Dock icon because of Electron's activation guard.
- Disabling the macOS menu-bar setting never removes the reopen control while the window is closed.
- Quitting (tray menu / `Cmd+Q`) stops everything — no orphaned background processes.
- Login launch is windowless and adds < 1s to login.

### F17 — AI reply drafting and inline autocomplete (opt-in, bring-your-own key)

**Off by default.** Enabling requires the user's own API key — an Anthropic key or any OpenAI-compatible endpoint (which also covers fully local models via Ollama / LM Studio for a zero-cloud setup). Settings shows only a masked key preview: the first four and last four characters, with short keys fully masked. Main creates this preview before sending it to the renderer. Keys live in `safeStorage`; requests go **directly from the client to the chosen provider**, no intermediary (consistent with D2). Provider-agnostic; model user-selectable with a sensible default per provider.

**Reply drafting:**

- **Draft reply** (`Mod+J`, also a palette command): generates the whole reply body for the open thread, streamed into the composer as a fully editable draft. When the authored reply region already contains text, that text accompanies the request as an immutable prefix and the generated continuation appends after it. Available from the reader or a reply/reply-all composer; full-message generation for new mail and forwards is outside v1.
- An empty inline reply or reply-all composer shows `Draft a reply with AI` with a `Mod+J` keycap only when AI writing is enabled
  and its configured provider has the required key. The hint is transient UI outside the saved draft and
  hides while typing. After a pause, a continuation hint appears at an authored paragraph’s end when no autocomplete is visible. Hide it inside text, selections, and signatures. Later paragraphs do not suppress it. New-mail and forward composers do not advertise
  the reply-only command.
  Generation, refinement, and undo affect the authored reply region above the signature. Preserve the
  Gmail signature and optional Attn footer, including user edits or removal (F6).
- **Voice profile:** tone preset (concise / friendly / formal) plus free-text standing rules ("sign off with 'Best, Chao'", "never use exclamation marks").
- Reply, refinement, and autocomplete context stop at the message being answered. Earlier cached messages remain context; later messages are excluded, including after reopening a saved reply.
- **Voice matching:** a handful of the user's recent sent replies from other conversations in the draft's owning account, selected locally, accompany the reply request as style examples (toggleable). Exclude the current conversation so later replies and their quoted history cannot enter through style examples. Autocomplete never includes these examples.
  Strip recognized quoted history, forwarded content, and signatures from each example before applying
  the excerpt limit. Prefer HTML quote and signature boundaries when available. Skip examples with no
  remaining authored text without falling back to the original body.
  Select candidate metadata before loading bodies. Limit each candidate's combined plain-text and HTML
  input to 64 KiB and the total loaded input per invocation to 256 KiB. Skip oversized candidates whole
  so clipping cannot break quote or signature boundaries.
- **Inline refine:** after a draft lands, a one-line instruction ("shorter", "more formal") regenerates it.
  A transient **Refine AI draft…** palette command focuses the instruction field while refinement is
  available.

**Inline autocomplete:**

- A **separate, default-off setting** enables short suggestions while typing in new messages, replies,
  reply-all, and forwards. Enabling reply drafting does not enable autocomplete. It uses the configured
  provider and model; cloud suggestions can incur repeated API charges. Local endpoints remain supported.
- After a pause in typing at the end of the authored body, stream one short continuation in gray at the
  caret, with no line breaks and at most 120 characters. Complete only the sentence being typed and discard
  any provider output after its first sentence-ending punctuation. Do not request or show autocomplete when
  authored text follows the caret. This suggestion is a preview outside the saved editor document; it never enters
  autosave, Gmail draft mirroring, copied mail text, or the outbox until accepted.
- `Tab` accepts a visible, current suggestion only while the body editor has focus. The accepted text is
  editable and one undo step; undo restores the previous text and caret. `Esc` dismisses the suggestion
  without closing the composer. Continuing to type dismisses it and can request a fresh suggestion after
  another pause. With no suggestion, normal `Tab` focus and `Esc` close behavior remain. `Shift+Tab`, arrow
  keys, and `Enter` keep their existing behavior; recipient completion, menus, and snippet pickers take
  precedence in their own contexts.
- Only deliberate typing at the end of the focused body of the foreground composer can trigger a request.
  The text before the caret must belong to an unfinished sentence. Opening, restoring, focusing a draft,
  finishing a sentence, or editing before existing authored text does not trigger a request. Suppress
  suggestions during IME composition, non-collapsed selections, reply generation/refine, and editing of
  quotes, signatures, tables, or preserved opaque content.
- Edits, caret/selection changes, blur, closing or sending the draft, account changes, and AI configuration
  changes invalidate pending and visible suggestions. Late results can never insert into another draft
  or account, and dismissing or accepting a suggestion does not itself request another.

**Privacy and request limits:**

- Full reply generation and refine run only on explicit invocation. Separately enabling autocomplete
  permits requests while actively typing; it does not permit background mailbox processing.
- The reply enable screen discloses the current thread, any existing authored reply text, voice profile,
  and optional style examples sent on each invocation. The autocomplete opt-in separately discloses that **unsent draft text leaves the
  machine while typing** when using a cloud endpoint. Its payload contains a bounded plain-text excerpt
  of the authored body around the caret (at most 2,000 characters before and 500 after), the current
  subject, selected tone, and standing rules. For replies, it also contains the current cached thread
  through the message being answered. Exclude quoted content embedded in the draft, signatures,
  recipients, attachments, and unrelated sent-mail style examples. Do not fetch mail solely to enrich
  autocomplete context.
- Debounce autocomplete by 300ms; allow at most one autocomplete request in flight app-wide, no more than
  one start per second and 20 per rolling minute. When typing replaces a canceled request inside the
  one-second cooldown, coalesce the latest eligible request until the cooldown expires; the rolling-minute
  cap and provider failures still skip without automatic retries. Cancel and discard results more than five
  seconds after dispatch. Slow, offline, or failed providers leave typing usable without recurring error
  toasts. Settings still expose configuration errors. Anthropic autocomplete requests explicitly disable
  model thinking for latency; reply and refine requests retain the provider default and give the token cap
  headroom for that thinking. A reply that reaches the provider's length limit surfaces as an error, never
  as a finished draft.
- Disabling autocomplete cancels its timers and requests and clears previews without disabling explicit
  reply drafting. The master AI switch stops both features; removing the key also disables both. Cancel
  in-flight work and ignore late responses. Content already sent to a provider cannot be recalled.
  Deleting a key removes its encrypted stored copy without touching OAuth credentials. Draft text and
  suggestions are not logged.
- **Never auto-sends.** Accepted autocomplete text and generated replies use the normal editable draft
  and send flow, undo send included. Unaccepted suggestions are never sent.

**Acceptance criteria**

- Master AI disabled → zero requests to any LLM endpoint, including after relaunch. Autocomplete disabled
  → zero typing-triggered requests even when explicit reply drafting is enabled.
- UI never blocks during either feature; composer keystroke and suggestion acceptance meet §7. `Esc`
  cancels reply streaming, retaining partial text; for autocomplete it dismisses the preview first.
- With voice matching off, reply requests contain no additional sent-mail style examples. Autocomplete
  contains only its bounded authored-body excerpt and current reply thread regardless of that toggle.
- A generated reply and an accepted suggestion are each undoable as one edit. When generation continues
  existing authored text, one undo removes only the AI continuation and preserves that text. No unaccepted suggestion
  appears in a saved, reopened, mirrored, or sent draft.
- Fake-provider tests prove debounce, request caps, timeout, IME suppression, keyboard precedence, and
  rejection of stale results after editing, switching drafts/accounts, closing, sending, or disabling.
- Settings and palette commands expose autocomplete enable/disable; the cheat sheet explains `Tab` and
  `Esc` in the body editor. Suggestions remain legible in both built-in themes without moving focus.

### F18 — Multiple accounts

Attn signs into several Google accounts at once and treats each as its own complete mailbox. One account is
**active**; everything the UI shows — list, reader, composer, search, palette, sidebar labels and counts,
splits, Snoozed, Outbox, Drafts — belongs to it. Switching accounts swaps that entire surface in place.
There is no unified inbox in v1 (§2) and no view ever mixes two accounts' rows.

- **Add account:** the account menu and palette offer *Add account…*, running F1's OAuth flow. Signing into
  an already-added address refreshes its tokens instead of duplicating the account. There is no hard account
  cap; the switcher digits cover the first nine.
- **Reorder accounts:** change menu and `Mod+1..9` order without changing the active account,
  its view, credentials, or running work. Persist the order in the encrypted token roster. Invalid or
  stale roster permutations fail without partial changes. Sign-out successor selection uses this order.
- **Switching:** `Mod+1..9` selects by the user-configured order; the account-chip menu and *Switch to
  <address>* palette commands cover every account. A warm switch renders the other account's cached mail in
  < 100ms and restores that account's last view, selection, and scroll from the session. Sidebar
  collapsed/expanded state is global; its contents are per account. While any composer is open, switching,
  adding, and signing out are unavailable (menu rows disabled, `Mod+1..9` and palette inert): a switch
  swaps the whole surface and would drop keystrokes the autosave has not yet captured, so `Esc` — which
  saves and closes the draft (F6) — always comes first. An OAuth completion never switches by itself
  either: adding an account only joins the roster, and activation goes through the same guarded switch —
  a sign-in whose browser flow completes minutes later, mid-compose, leaves the account added but not
  active rather than swapping the surface. The guard is symmetric: while a switch is settling (it can wait
  on a retiring session for a few seconds), every composer open is inert, so no draft can appear only to be
  torn down when the switch lands.
- **Scoping:** threads, labels, splits and their notification settings, contacts and recipient autocomplete ranking,
  local and server search, snooze and follow-up reminders, drafts, outbox rows, the session undo stack,
  historical sync limit, Attn signature footer preference, and command usage all key off the owning
  account. App-level preferences stay global: theme, launch at login/tray, undo-send delay, auto-advance,
  notification pause, sidebar collapse,
  and (when they ship) the
  F17 provider key, model, voice profile and enable toggles (including autocomplete), and F8 snippets.
- **Background liveness:** every signed-in account keeps working while inactive — polling (the active
  account at F2's 15s/60s cadence, inactive accounts at the 60s background cadence), draining its action
  queue and outbox, mirroring drafts, firing snooze returns, and producing notifications. An undo-send
  window queued on one account counts down and sends even if the user switches away. Historical indexing
  (lifetime sweep → attachment flags → FTS backfill) runs for one account at a time, active account first,
  so a newly added account's backfill never competes with every other account at once — and never with
  interactive work (F2's priority rules apply per account and across accounts).
- **Notifications & badge:** per F12 — all accounts notify, clicks switch accounts before focusing, and the
  badge sums across accounts.
- **Auth failure is per account:** an account whose token refresh fails pauses only itself. The account menu
  marks it *Reconnect*, the account chip carries an attention mark while any account needs reauth, and the
  existing auth-paused banner appears when that account is active. Reconnecting resumes that account's
  queues and polling and no other's.
- **Sign out:** the account menu and palette use this short label. The confirmation identifies the account
  and asks what to do with local data. Confirming always removes the account's tokens
  and stops its sync. Cancel receives initial focus; neither removal choice is preselected. **Delete local data** purges every local trace —
  store rows in every account-keyed table, FTS entries, attachment and draft spool files, reminders, and
  per-account settings — so removal is the privacy boundary and re-adding re-syncs from scratch (local data
  is a cache of Gmail, decision #6's posture). **Keep local data** leaves those rows in place, unreadable
  and unlisted until the same address is added again, at which point sync resumes from its stored cursors
  instead of re-backfilling. The active account falls to the next remaining one; removing the last account
  returns to F1's signed-out screen.
  Deletion waits for attachment files before purging the identifying store rows. If deletion fails, the
  account stays signed out, the remaining data stays available for a retry, and a dismissible warning
  remains visible after the view changes. Re-adding the account allows another Delete attempt.
- Out of scope for v1: unified inbox, cross-account search, moving mail between accounts, a From-account
  picker in the composer (F6), per-account themes.

**Acceptance criteria**
- Warm account switch (cached mail) < 100ms, restoring that account's selection and scroll; nothing from the
  previous account — rows, counts, labels, chips, drafts — survives the swap.
- Sidebar totals refresh independently of list and label responses after an account switch. Paginated Spam selections restore like other cached mailboxes.
- Adding a second account leaves the first account's sync cursors, splits, and reminders untouched, and both
  accounts' pollers run afterward.
- Airplane mode: triage on account A, switch to B, quit, relaunch online → A's queued actions drain without
  touching B's mail; a send queued on an inactive account leaves on its deadline.
- A notification from an inactive account opens its thread with that account active; the badge equals the
  sum of every account's notification-enabled unread count.
- Revoking account A's access pauses A's sync and actions and marks the account menu while B keeps polling;
  reconnecting resumes A only.
- Removing an account leaves zero rows in any account-keyed table, zero FTS entries, and zero spool files
  for it, survives relaunch, and lands on the next account (or the signed-out screen).

---

## 5. Keyboard map (v1 defaults)

*Our defaults — largely Gmail-compatible, not configurable in v1 (remapping is post-v1).*

**Global**

| Keys | Action |
|---|---|
| `Mod+K` | Command palette |
| `C` | Compose |
| `/` | Search |
| `Z` | Undo last action |
| `Esc` | Back / close (pane, picker, composer) |
| `Mod+/` | Keyboard cheat sheet |
| `Mod+,` | Settings |
| `Mod+1..9` | Switch to account by configured order (F18) |

**List & navigation**

| Keys | Action |
|---|---|
| `J` / `K` | Next / previous conversation in the list or reader |
| `↓` / `↑` | Next / previous conversation in the list; scroll while reading |
| `Enter` | Open conversation |
| `Tab` / `Shift+Tab` | Next / previous Inbox split, wrapping at both ends; `Tab` returns to Inbox from another mailbox |
| `←` / `→` | Previous / next Inbox split aliases |
| `X` | Select conversation (`Shift+J/K` or `Shift+↑/↓` extends) |
| `G` then `I` | Go to Inbox |
| `G` then `A` | Go to All Mail |
| `G` then `T` | Go to Sent |
| `G` then `D` | Go to Drafts |
| `G` then `S` | Go to Starred |
| `G` then `H` | Go to Snoozed / Reminders |
| `G` then `P` | Go to Spam |
| `G` then `R` | Go to Trash |
| `G` then `O` | Go to Outbox (the on-demand local view of queued/sending/failed/needs-review sends, F3) |

**Triage** (list or conversation)

| Keys | Action |
|---|---|
| `E` | Mark done (archive) |
| `Shift+E` | Mark not done (restore to Inbox) |
| `H` | Snooze / remind me later |
| `#` | Trash |
| `S` | Star |
| `U` | Toggle unread |
| `!` | Spam |
| `L` | Label picker |
| `V` | Move to a mailbox, Inbox split, or user label |

**Conversation**

| Keys | Action |
|---|---|
| `R` / `A` / `F` | Reply / reply-all / forward |
| `Enter` | Expand the selected collapsed message; reply all when it is already expanded |
| `Mod+J` | Draft AI reply (F17; opens the inline reply composer) |
| `N` / `P` | Next / previous message in thread |
| `O` | Expand / collapse message |
| `Tab` | Move focus normally; reveal a hidden trail when focus reaches its `...` control |

**Composer**

| Keys | Action |
|---|---|
| `Mod+Enter` | Send |
| `Mod+Shift+D` | Discard the active composer draft or the selected row in Drafts |
| `Mod+B` / `Mod+I` / `Mod+U` | Bold / italic / underline |
| `Mod+Shift+K` | Insert link (`Mod+K` stays reserved for the palette everywhere) |
| `Mod+;` | Insert snippet |
| `Mod+J` | Draft AI reply (reply/reply-all only, F17) |
| `Mod+Z` | Undo body text; one press removes a whole AI draft or accepted autocomplete, or restores a `;trigger` after snippet expansion |
| `Mod+A` | Select only the authored body, excluding the Gmail signature, Attn footer, and quoted history |
| `Tab` | Accept a visible autocomplete suggestion in the focused body; otherwise normal focus behavior |
| `Esc` | Dismiss autocomplete, cancel AI streaming, or close Refine first; otherwise close (draft saved) |

---

## 6. Architecture

```
┌─────────────────────────── Electron ───────────────────────────┐
│                                                                │
│  Renderer (React + TS)          Service layer (Node + TS)      │
│  ┌──────────────────────┐       ┌───────────────────────────┐  │
│  │ Inbox / Conversation │ typed │ Sync engine (MailProvider │  │
│  │ Composer / Palette   │  IPC  │  interface → GmailProvider)│ │
│  │ Command registry     │◄─────►│ Action queue + reducer    │  │
│  │ Local read models    │       │ Scheduler (snooze/follow- │  │
│  └──────────────────────┘       │  up/undo-send timers)     │  │
│                                 │ SQLite + FTS5             │  │
│  Main process: windows, OAuth   └───────────────────────────┘  │
│  loopback, notifications, badge, safeStorage, auto-update      │
└────────────────────────────────────────────────────────────────┘
                                   │ HTTPS
                             Gmail API
```

- **Renderer** is sandboxed (no Node integration, `contextBridge` + typed IPC only). It reads from lightweight query APIs over the local store and issues *commands*; it never talks to Google.
- **The service layer runs in an Electron utility process** behind Electron-free store/provider interfaces.
  The utility owns SQLite, Gmail fetch, backfill, derived-data rebuilds, action replay, drafts, outbox work,
  schedulers, and local reads. The main process is the typed IPC and lifecycle broker and retains native-only
  work such as OAuth/keychain access, windows, dialogs, notifications, and badges. The supervisor restarts the
  utility after a crash, and every indexing cursor resumes from a durable checkpoint. Interactive actions
  and outbox work have priority over historical indexing. The action executor and outbox sender live beside
  SQLite, so the boundary does not create a second reducer or send implementation. With multi-account (F18)
  the utility owns one sync session per signed-in account — per-account poller, cursors, generation guard,
  and quota limiter — while the executors drain every account's durable queues, active account first, and
  the historical-indexing chain runs for one account at a time. The active-account pointer lives in the
  utility. Renderer-facing mail broadcasts are filtered to the active account. Account-specific events carry
  `account_id`. The renderer remounts its mail tree when the active account changes.
- **One reducer, two sources:** server history events and local optimistic actions flow through the same state-transition code, which is what keeps optimistic UI and sync convergent.
- **Scheduler** owns every timer (snooze due-times, follow-up deadlines, undo-send windows); on launch it executes anything that came due while the app was closed (catch-up, D2).

**Local schema:** `src/main/db/schema.ts` defines the current tables. `src/main/db/migrations.ts` defines the ordered upgrade path. Scope account-owned data by `account_id`.

**Security and privacy:** OAuth tokens and AI provider keys use `safeStorage`. SQLite mail data stays under the operating-system user profile. Attn does not encrypt the mail database.

The app connects to Google for mail. AI requests go to the selected provider only after opt-in. Reply commands send the specified mail context. Separately enabled autocomplete sends a limited excerpt of unsent text. AI does not process the mailbox in the background.

Signed release builds contact the configured update feed. Attn has no telemetry. Remote images load directly from senders by default. A global block setting and per-sender exceptions control those requests.

**HTML mail rendering:** sanitized (DOMPurify-class allowlist), rendered in a sandboxed `<iframe>`/webview with no script execution, links open in the system browser. Some legitimate senders serve images with `Cross-Origin-Resource-Policy: same-origin`, which Chromium would block inside that frame; the app removes only that response header, only for image requests originating from the mail frame — no other request or header is modified. The frame is measured after load and on resize, preserves horizontal overflow inside the frame, and remains mounted when quote/signature visibility changes. A shared surface classifier gives fallback content and HTML without a non-neutral authored canvas the native Attn treatment; non-neutral backgrounds and background images keep a light document canvas. Native mail clears sender background patches in every palette. Before classification and display, repeated Apple Mail gray lines with white text wrappers use the native reading background. This display-only cleanup requires the matching text-only pattern on at least two nonempty sibling lines; isolated highlights, layout styling, stylesheet-driven documents, and lines inside tables or background containers keep their formatting. Stored mail and outgoing quoted HTML remain unchanged. The existing View original control bypasses this cleanup. It keeps authored inline text colors in light palettes; in dark palettes it adjusts chromatic colors to readable contrast and replaces low-contrast neutral foregrounds with the native default. Constrained sender canvases center within a solid light mail surface. Typography, media, tables, layout attributes, and layout-only CSS are not canvas evidence. The composer quote preview uses the same decision. In the reader, a simple reply above rich collapsed history uses the native background and normal card spacing. The rich history keeps its own light canvas when expanded. This split applies only to ordinary block wrappers with inherited text styles. Stylesheets, shared padding or sizing, and table, list, or flex/grid layouts retain one frame. Both split frames remain scriptless and mounted across quote toggles. View original renders the complete document together. Filename-bearing MIME parts count as attachments whether Gmail supplies an attachment ID or inline base64url data. The stored `inlineData` field is withheld from `ConversationMsg`, and inline-delivered attachments can download without a network request. For `cid:` rendering, however, `mail:getInlineImage` deliberately sends matching image content through the typed preload bridge as an allowlisted-MIME base64 `dataUrl`, capped at 25 MB; the renderer assigns that value to the image in the scriptless mail iframe. A direct MIME Content-ID match takes precedence, with a unique CID or `alt` filename accepted as a compatibility alias when sender HTML and MIME generated different identifiers. Ambiguous and unresolved references remain inert broken-image placeholders.

**Packaging:** `electron-builder` creates personal and release builds. Personal builds need no release credentials and never check for updates. Release builds require signing, macOS notarization, and explicit distribution metadata. See [the release guide](RELEASE.md).

The rolling update feed declares the target schema and the oldest supported schema. The updater checks this range before download and installation. At startup, `openDatabase()` applies the required migrations in one transaction and checks integrity before commit. Missing or incompatible metadata rejects the update. Every schema change adds one immutable migration. An upgrade must not delete a profile or require manual SQL.

**Testing:** unit tests cover state changes, sync, persistence, and command registration. Playwright drives the built Electron app with isolated fixtures and mock providers. See [the test guide](TESTING.md).

---

## 7. Performance budgets

| Metric | Budget |
|---|---|
| Cold start → interactive inbox (warm OS cache) | < 2s |
| Open cached conversation | < 50ms |
| Triage action visual feedback | < 16ms |
| Command palette open / re-rank | < 50ms / < 30ms |
| Split switch / rule re-bucket (10k threads) | < 50ms / < 1s |
| Account switch (warm, cached account) | < 100ms |
| Local search p95 (50k messages) | < 100ms |
| List scroll (10k threads) | 60fps |
| Composer keystroke latency | < 16ms |
| Autocomplete acceptance → editable text painted | < 16ms, with no network wait |
| New-mail notification latency (app running) | ≤ 30s |
| Memory, steady state (50k messages synced) | < 500MB |

The dedicated Electron performance job now drives a 10,000-thread production build on every pull request. It enforces a windowed DOM, p95 scroll-frame pacing, the 500 MB application-owned memory ceiling, cached conversation open, single/bulk triage feedback, and composer open/mutation/paint budgets. Use `npm run e2e:perf` to reproduce these checks. Use `npm run e2e:perf:scale` for reads that must remain bounded as the store grows.

Initial sync is measured at both completion points above: time to interactive-ready is a product budget;
time to finish background indexing is reported with mailbox size, stage request counts, effective
threads/minute, and quota-wait time. A single wall-clock target for full indexing would be misleading across
mailboxes and Gmail quota regimes. Background work must preserve every interaction budget in this table.

Autocomplete must preserve the composer budget while a provider is slow or unavailable. F17 bounds request
frequency and discards responses after 1,500ms; provider latency is measured separately from local editing
latency and is not a prerequisite for typing, saving, or sending.
