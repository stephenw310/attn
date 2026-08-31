# Attn — Product & Technical Spec (v0.17)

A desktop email client for **macOS and Windows** modeled on Superhuman's core idea: email triage so fast and keyboard-driven that reaching inbox zero is the default state, not an aspiration.

This spec covers **v1: the inbox experience only**. Calendar is explicitly out of scope. Mobile and web are out of scope.

---

## 1. Vision & principles

**Speed is the product.** Every other feature exists in service of moving through email faster.

1. **Instant, always.** Every interaction feels immediate: actions apply optimistically from a local store, never waiting on the network. Budgets: triage feedback < 16ms, open a conversation < 50ms, search results < 100ms, cold start < 2s.
2. **Keyboard-first, mouse-optional.** Every action is reachable from the keyboard. The mouse always works, but is never required.
3. **Triage to zero.** The core loop is: read → decide (done / snooze / reply / delegate to later) → auto-advance to next. The inbox is a queue to empty, not a place to store mail.
4. **Local-first.** All reads and writes hit a local database. Sync happens in the background. The app is fully usable offline; actions queue and reconcile when back online.
5. **One clear focus.** Minimal chrome, one primary pane of attention, no clutter. The command palette replaces menus and toolbars as the primary surface for everything else.

---

## 2. Scope

### In scope (v1)

- Gmail accounts (Google OAuth, Gmail API) — multiple Google accounts per profile: add, switch, reorder, remove (F18)
- Full content-width conversation list + focused conversation view, threaded conversations
- System mailbox views: Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash
- Keyboard triage: mark done, snooze ("remind me later"), trash, star, unread, spam, label, move
- Auto-advance after triage; universal undo (`Z`)
- Command palette (`Mod+K`) exposing every command
- Split inbox: Important / Other + user-defined splits by rule
- Compose, reply, reply-all, forward; contact autocomplete; drafts; attachments
- Undo send (delayed send window)
- Snippets (reusable text templates)
- Follow-up reminders ("remind me if no reply")
- AI reply drafting and inline autocomplete, each opt-in, using the user's own provider (F17)
- Instant local full-text search with operators
- Native notifications + dock/taskbar unread badge
- Background mode: launch at login, tray/menu-bar presence (F16)
- Inbox-zero state, curated built-in themes
- Offline action queue, background sync
- Packaged installers for macOS + Windows, auto-update

### Out of scope (v1)

| Excluded | Why / when |
|---|---|
| Calendar | Explicitly excluded by product decision |
| Mobile, web, Linux | Desktop macOS + Windows only for v1 |
| Read statuses / open tracking | Requires a hosted tracking-pixel server; v1 has no backend (see D2) |
| Send later (scheduled send) | Accurate delivery requires execution while the computer may be off; deferred to the v1.5 companion script rather than shipped half-working (see D2, F7) |
| Global-hotkey quick panel (quick compose + search) | v1.1 — first post-v1 feature; keeps cross-platform window-management edge cases out of v1 |
| Outlook / IMAP accounts | v2; sync engine is built behind a provider interface to allow it |
| AI beyond reply drafting and inline autocomplete (summaries, auto-triage, semantic search) | v2+; v1 ships only the opt-in composer features in F17 |
| Team features (shared threads, comments) | Requires backend + multi-tenant model |
| Unified inbox across accounts | v1 ships multiple accounts as separate switched mailboxes (D4 revised, F18, §9 #21); merging them into one list remains post-v1 |
| Full keyboard remapping UI | Post-v1; v1 ships fixed defaults |
| Custom themes (user-defined palettes / accent colors) | Post-v1 (v1.1 candidate); v1 ships four curated palettes (F14). D6's semantic token system is the enabler — a custom theme is just another token set |

---

## 3. Key decisions

**D1 — Gmail only in v1.** Gmail's API gives us native threading, labels, incremental history sync, and drafts. The sync engine is written against a `MailProvider` interface so Outlook (Microsoft Graph) can be added in v2 without touching the UI or local store.

**D2 — No backend server in v1 (deliberate).** The app talks only to Google — plus, strictly opt-in, a user-chosen LLM provider for AI reply drafting and autocomplete (F17). This is a conscious trade, made for three reasons: (1) **token custody** — a server would have to hold Gmail OAuth refresh tokens, the most sensitive credential a mail app touches, turning a client into infrastructure that must be secured, operated, and trusted; (2) **operational burden** — an always-on scheduler means uptime, monitoring, and deploys for what starts as a personal tool; (3) **v1 velocity** — every piece of surface area cut is time returned to the core triage loop.

Design consequences:
- **Read statuses are out** (they need a hosted pixel endpoint).
- **Send later is out of v1** — exact-time delivery while the computer may be asleep or off is impossible client-side, and a "sends late on next launch" version isn't worth shipping. See F7 for the v1.5 plan.
- **Snooze and follow-up reminders run on local schedules with catch-up semantics.** If the app isn't running when a timer fires, it fires on next launch. These degrade gracefully — a reminder is only actionable at the computer anyway. To make "app not running" rare, the app **launches at login and keeps running in the tray/menu bar** when the window is closed (default on, see F16).
- **New mail arrives by polling** (Gmail push notifications require a public Pub/Sub webhook). Poll interval: 15s foregrounded, 60s in background — worst-case notification latency ~30s foregrounded.

Serverless roadmap: **v1** pure client → **v1.5** optional *companion Apps Script* in the user's own Google account (restores send later, adds exact-time snooze return visible from all devices — see F7) → **v2** small hosted backend (adds read statuses, true multi-device state).

**D3 — Electron + TypeScript + React (confirmed over Tauri, §9).** Two reasons beyond ecosystem maturity: (1) **one rendering engine** — Electron ships one pinned Chromium on both OSes; Tauri uses the OS webview (WKWebView on macOS, WebView2 on Windows), meaning two engines to test, with the differences concentrated on this app's two most quirk-sensitive surfaces: the contenteditable composer and arbitrary HTML-email rendering. (2) **one language** — the sync engine stays in TypeScript beside the UI, instead of moving to Rust or shipping a Node sidecar that gives back the footprint win. Tauri's genuine advantages (~10× smaller installer, lower baseline memory, faster cold start) don't move the budgets that define this product (§7): interaction latency and search speed come from the local-first architecture, not the shell. The UI is plain web tech, so a shell swap stays possible if footprint ever becomes the real complaint.

**D4 — Multi-account ships in v1 as switched accounts, not a merged view (revised 2026-08-28, §9 #21; originally deferred to v1.1).** Every row has been keyed by account since day one; v1 now puts N signed-in Google accounts on top of that store. Exactly one account is **active** in the UI at a time — list, reader, composer, search, sidebar, and palette all read as if that account were the only one — while every signed-in account stays live in the background: polling, action replay, outbox sends, draft mirroring, snooze returns, and notifications continue for inactive accounts. Switching (`Mod+1..9`, account menu, palette) swaps the whole surface in place. A unified cross-account inbox stays out of v1 (§2). Full behavior in F18.

**D5 — SQLite + FTS5 as the local store.** Message headers for the account's whole lifetime (staged: interactive windows first, then a low-priority background sweep — §9 #17), full bodies for the last 90 days of Inbox mail, older bodies fetched on demand and cached permanently. Attachment bytes are never bulk-synced: metadata rides with full-format fetches, content downloads on demand. Search runs entirely locally against FTS5.

**D6 — Visual direction: "Dispatch" (settled 2026-08-09; mockups in `design/explorations/b2-*.html`).** Cool deep graphite surfaces, one amber signal color, a single sans family with tabular numerals doing the instrument work, and the lowercase `attn:` wordmark with an accent colon. Signature element: the **queue readout** ("● ● ● ○ ○ · 3 to zero") persistent in the top bar. That 44 px React top bar occupies the native title-bar area while macOS traffic lights and Windows controls remain native and unobstructed. Layout (revised 2026-08-12 after M1 dogfood, 2026-08-14 for the new-message composer, 2026-08-15 for thread drafting, and 2026-08-24 for navigation, §9 #7/#9/#11/#13): a 216 px left sidebar owns the wordmark plus mailbox and user-label navigation while the content region switches between the list and a focused conversation. A persistent top-bar control collapses the sidebar completely and restores it; `Mod+B` invokes the same command. The choice persists in the local profile. The sidebar stays in the chosen state while reading; a full-window new-message composer hides it so writing owns the window. `Esc` or the visible Back/List control restores the prior list at the same selection and scroll position. Reply, reply-all, and forward are the deliberate exception: their composer is the final inline card beneath the conversation so the source mail remains visible while writing. Adjacent cached conversations preload in the background so `J`/`K` changes the reader instantly without showing competing panes. This supersedes the centered overlay, the interim reading split, and the docked new-message composer; simultaneous list/reader variants are rejected. All Mail rows show a green checkmark after the timestamp when the thread is done and no longer carries the `INBOX` label. The leading unread dot remains independent because a done thread can still be unread. A compact title-only row identifies the active mailbox or label without repeating a count. An Inbox split strip appears only when at least one split exists and never moves into the sidebar (hot splits carry counts; overflow behind `···`; full jump-list in the palette). Settings live behind the account-chip menu (Settings, keyboard shortcuts, split rules, sign out); there is no hamburger. Built-in themes share the same semantic tokens (F14).

**Modifier convention:** `Mod` = `Cmd` on macOS, `Ctrl` on Windows. All shortcuts in this spec are written platform-neutrally.

> **On fidelity:** keyboard bindings, layouts, and behavioral details in this spec are *our* defaults — Gmail-compatible where sensible, inspired by Superhuman's philosophy, but not claimed to be an exact replica of Superhuman's bindings or UI.

---

## 4. Feature specifications

### F1 — Onboarding & auth

Sign in with Google via OAuth 2.0 **authorization-code + PKCE, loopback redirect** (opens system browser, redirects to `http://127.0.0.1:<port>`). Requested scopes: `gmail.modify` (covers read, label changes, and send) plus basic profile/email.

Tokens are stored via Electron `safeStorage` (macOS Keychain / Windows DPAPI). No credentials ever touch disk in plaintext.

**Multiple accounts (F18, added v0.17):** the same flow adds each additional account — **Add account…** lives in the account menu and the palette. Every account has its own token set; the encrypted token file stores a map keyed by the account's normalized email address, and a legacy single-account `tokens.bin` is folded into that map on first launch, then removed. Signing in with an already-added address refreshes that account's tokens rather than duplicating the account. All accounts share the one user-supplied OAuth client (dev-mode distribution below); Gmail's per-user quota is granted per Google account per project, so each added account brings its own quota budget instead of dividing one.

**Signed-out state (added v0.13, PR #27):** a signed-out launch shows a dedicated sign-in screen, not a preview of someone else's mail — the earlier mock inbox is gone. The mail tree does not mount behind that screen, so no mail keybinding, IPC subscription, or command registration is live while onboarding; the sign-in action is autofocused so `Enter` reaches it directly. When `oauth.config.json` is missing the screen explains the one-time setup and links to it rather than offering a dead button, and a failed auth-status probe offers a retry instead of hanging on a checking state.

⚠️ **Real-world constraint:** `gmail.modify` is a restricted scope. **Decision for v1: dev-mode distribution** — each user supplies their own Google Cloud OAuth client (unverified-app warning is expected). Google's app verification + security assessment is deferred until/unless there is a public release (§9).

**Acceptance criteria**
- Fresh install → signed in and reading first conversations in under 60s on a typical inbox (metadata streams in; UI is usable before backfill completes).
- Revoking access from Google account settings degrades gracefully to a re-auth prompt, never a crash or silent hang — and with several accounts signed in, it pauses only the revoked account (F18).
- Adding a second account never restarts or resets the first account's sync cursors.
- A signed-out launch (zero accounts) is fully operable from the keyboard alone, and no mail shortcut does anything there.

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
7. **lifetime** — a low-priority, quota-throttled, resumable header sweep with no date bound (§9 #17).

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

*Shipped staging and storage:* the full bounded pipeline runs as specified — inbox → bodies → drafts → all-mail →
spam → trash → per-label reconcile (the retired `sent` stage is subsumed by all-mail; old `sent` cursors
route to it) — then T13A's independent, low-priority lifetime sweep starts. Spam/Trash reconciliation
verifies each locally-labeled thread missing from the server listing by direct fetch and deletes only on
404, never on listing absence. Per-message labels are also stored and drive mailbox membership and reader
subsets. Expired-history recovery now walks the complete unfiltered, Spam, and Trash id union before deleting
absent local snapshots, and a partial listing deletes nothing. The SQLite store and sync workers run in the
utility process. The mailbox surfaces shipped with T22; the remaining M3 work is search (§9 #17).

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
§9 #22. Older mail remains available through Gmail search and on-demand reads.

**Lifetime header sweep (T13A as revised by §9 #17; supersedes the Sent-only pass of §9 #15):** after
interactive readiness, a resumable low-priority pass walks lifetime message headers across the whole account
(no label filter, newest first), skipping threads already stored. It persists its own cursor, reports
unique locally indexed threads—including metadata written by every earlier stage—against
`getProfile().threadsTotal`, reports message context from `getProfile().messagesTotal`, and never downloads
old bodies or attachments. The durable listing count remains cursor bookkeeping rather than user-visible
progress; page-level `resultSizeEstimate` is not a mailbox total and must never be used as the denominator.
Contact statistics derive from the same header stream — recipients of Sent mail, senders of
received mail — so an address last emailed years ago autocompletes locally; messages labeled SPAM or TRASH
never contribute to contacts. While the pass runs, sync status reads **Live · indexing older mail** with
progress and quota-wait detail. Importing a user's saved Google Contacts through the People API remains a
separate opt-in product decision because it adds OAuth scope and consent requirements; autocomplete must not
imply that the mail-derived index contains an address book the user has never emailed.

**Historical sync limit (M4, F15):** each account has its own limit, defaulting to 400,000 conversations
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

After interactive readiness, the footer reports **Live · indexing older mail** rather than a blocking
“Syncing” state. The lifetime line reads **X of Y threads indexed · time remaining**, where X is the account's
unique local thread count and Y is the current profile thread total. The ETA estimates time to the local
sweep limit or the account total, whichever is smaller; disabling the limit uses the account total. No ETA
is shown once that target is reached or when the account total is unknown. The footer also exposes an
explicit quota-wait state instead of appearing stuck during backoff. The top-bar “N to zero” value is the
total unread Inbox count, not sync progress, and may exceed the current rendered-list window.

**Incremental:** poll `history.list` from the last stored `historyId` (15s foreground / 60s background). Each cycle also refreshes the label catalog (`labels.list`, 1 unit): history reports label *applications*, never label create/rename/delete, so the catalog would otherwise go stale (T21). On `historyId` expiry (HTTP 404), fall back to a delta re-list; once non-Inbox mail is cached (M3), that recovery must also reconcile every cached system label and tombstone threads purged server-side while the app was away. Spam/Trash auto-purge otherwise leaves ghost rows. The completed account listing identifies candidates, but only a direct per-thread 404 authorizes deletion because threads can move between sequential listing scopes. All writes funnel through a single reducer so server-originated and locally-originated changes apply identically.

**Action queue:** every user action (archive, label, star, send…) is:
1. Applied to the local store immediately (optimistic).
2. Appended to a durable queue (`action_queue` table).
3. Executed against the Gmail API with retries + exponential backoff. Label operations are naturally idempotent. Send is guarded by an outbox state machine (see F6) so it executes **exactly once**.

Conflict rule: server state wins, except locally-pending actions replay on top of it.

**Sync visibility (added v0.13; shipped at M1 exit):** local-first hides the network, so the app must say what the network is doing. The footer carries a persistent sync status — **Live**, **Checking**, **Syncing** (with backfill stage progress), **Offline**, or **Error** — distinguishing "network down, local mail fully usable" from "sync is failing". The error state opens details with **Retry now** and **Copy details** actions (both also registered commands); offline failures retry automatically when connectivity returns. The top-bar queue readout appends "· N pending" whenever local actions await server replay.

**Acceptance criteria**
- Airplane mode: archive 20 conversations, quit the app, relaunch online → all 20 sync; none lost, none duplicated.
- Kill the app mid-sync → no corruption; next launch resumes from stored `historyId`.
- A change made in Gmail web (e.g. archive) is reflected locally within one poll interval.
- Historical-limit changes survive restart, preserve cached mail and unrelated sync cursors, and apply
  only to the selected account. Raising a cap restores attachment flags for newly indexed older mail;
  an unchanged or lower reached cap performs no additional lifetime Gmail requests.
- Losing the network mid-session flips the status to Offline while reads and triage keep working; restoring it returns to Live and drains the queue with no user action.

### F3 — Inbox list & conversation view

**List ⇄ focused conversation** (D6 as revised 2026-08-24, §9 #11): the list owns the content region while deciding. Opening a conversation replaces the list with one dedicated reading surface while the navigation sidebar stays put. Closing restores the list at the same selection and scroll position.

**Mailbox and label navigation (M3, §9 #10):** everything this section describes — mailboxes, counts, user labels, splits, the list, and the reader — belongs to the active account (F18); switching accounts swaps it all at once. A left sidebar, expanded by default and completely removable with the persistent top-bar toggle, groups Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash, Outbox, and the account's user labels. Every system row keeps its `G` chord visible beside an exact local conversation total, including zero; large totals use a compact visual label while exposing the exact value. The top-bar queue readout remains the unread Inbox total. The active destination has one stable highlight. System mailboxes remain reachable from the command palette (`Go to …`) and their `G` chords. Label chips and label rows open the same local list view. Important/Other and user-defined splits are queues inside Inbox, not mailbox destinations, so a compact split strip appears above the Inbox list only when splits exist. The ordinary list begins directly below the top bar.

- Inbox = `INBOX`; Sent = `SENT`; Drafts = `DRAFT`; Starred = `STARRED`; Spam = `SPAM`; Trash = `TRASH`; Snoozed is the local reminders view from F4. Spam and Trash include a thread when any message carries the matching label. All Mail includes a thread when any message is outside `SPAM` and `TRASH`, including archived mail. A partially trashed thread therefore appears in both All Mail and Trash. Normal and All Mail readers hide spammed messages. They keep each trashed message's chronological position as a compact `This message was moved to Trash. Show message.` marker. `Show message` reveals that message only in the current reader and does not restore it or change its Gmail labels. Spam and Trash readers show only messages from the active mailbox. Draft and legacy `CHAT` messages never render as sent mail.
- Mailbox and user-label queries run entirely against the local store. M3 expands metadata sync beyond the current Inbox window so lifetime system and user-label membership is cached; switching a cached destination never waits on Gmail. Bodies still follow F2's on-demand policy.
- Switching destinations closes any open conversation and restores that destination's prior selection and scroll when revisited. Opening a conversation otherwise uses the same focused behavior in every message mailbox and label view. A Draft row opens its crash-safe M2 composer draft rather than a read-only conversation.
- Triage actions immediately remove a row when it no longer matches the active mailbox. Spam and Trash are browsable but v1 still provides no permanent-delete or empty-folder action.
- Drafts merges locally composing outbox rows with cached Gmail Drafts. A local draft is discoverable offline before its first successful Gmail mirror, and multiple simultaneous drafts remain distinct. M3 owns the unified Drafts mailbox behavior.
- Outbox is a local operational view rather than a Gmail mailbox. The sidebar, top-bar pending readout, and **Go to Outbox** command open queued, sending, failed, and needs-review items; actionable rows reopen in the composer without discarding local content.

- The content-width list groups conversations under Today, Yesterday, Last 7 days, Earlier this month, then calendar-year headings so month/day timestamps on old mail stay unambiguous. It shows sender(s), subject, a 1–2 line snippet, timestamp, and chips (attachment, starred, snoozed-return, follow-up). Unread rows are visually distinct. Every mailbox and user-label view reads 100 rows initially, loads the next keyset page near the tail, and keeps fixed-height windowing with overscan over the accumulated rows. No list count is shown because a loaded-page count is not a mailbox total.
- In the list, `J`/`K` and unmodified `ArrowUp`/`ArrowDown` move the selection.
- `Enter` or clicking a row opens the **full-window conversation** at a responsive readable measure (576–896px), positioned at its newest message or restored thread-bound draft. Its header contains a visible Back/List control, subject, quiet queue position ("4 of 12"), and `Esc` hint. The newest message is expanded; older messages start as one-line summaries and their bodies (including HTML frames) are not mounted until expanded. Clicking an expanded message's header collapses it into that same summary row; clicking the summary reopens it.
- While reading, `J`/`K` opens the next/previous conversation at its newest message or restored draft; at the first conversation, `K` returns to the full-width list instead of remaining in the reader. The adjacent conversations are fetched into the local renderer cache beforehand so this usually has no loading state. Unmodified `ArrowUp`/`ArrowDown`, `Space`/`Shift+Space`, and `PageUp`/`PageDown` scroll the current conversation, while `Shift+ArrowUp`/`Shift+ArrowDown` extend the selection exactly as `Shift+J`/`Shift+K` do — the arrow aliases behave the same in the list and the reader. Modifier+key chords retain their platform/browser meaning. Keyboard handling continues after clicking recipient, attachment, or trim controls and while focus is inside an HTML-mail frame; `Enter` on a focused mail link retains its native link action. Unless a transient overlay consumes it first, `Esc` or Back/List returns to the full-width list from every Tab stop—including focused buttons and mail links—with selection and scroll intact.
- **Message display:** each message card shows the sender, with the active account rendered consistently as `Me` before and after send confirmation, plus a recipient summary ("to me, Priya · cc Daniel") that expands on click to the full From/To/Cc/Bcc/Reply-To set with the full date, the body, and attachment chips (filename + size — click downloads to the OS Downloads folder and reveals the file). The actual outgoing `From` header uses the primary Gmail send-as display name so recipients see the configured identity. Bare HTTP(S) and `www.` URLs in plain text or unlinked HTML text render as external links. Quoted trails and signatures auto-collapse behind a plain-text `...` control rendered inline at the trim boundary; the control stays in place while expanding/collapsing and a second click collapses again. `Tab` always retains native focus navigation across the product. For collapsed HTML mail, the `...` control precedes links inside the mail frame in keyboard order; reaching it reveals the hidden trail without changing the reading viewport dimensions, and the next Tab continues into the mail links. Revealing a long trail makes the existing reading surface scroll instead of growing the window. Text-like HTML and fallback text use Attn's padded native reading surface. Typography, media, tables, dimensions, alignment, and layout-only CSS remain native because they do not require a white document. Meaningful inline text colors remain distinct on the native dark surface, with low-contrast hues brightened and ordinary dark foregrounds normalized to the native text color. Uncolored quoted text is dimmed so preserved answer colors remain easy to distinguish. HTML whose rendered meaning depends on the winning non-neutral background or background image keeps a light document canvas shared by its body, trim control, and attachments. Attn does not add padding inside light documents; sender-authored body padding still takes precedence. Light HTML body containers use the message card's 10px corner radius. Decorative markup confined to a signature does not promote the message. A real authored canvas inside a quoted trail is content and retains the light treatment, while ordinary quoted formatting does not turn every later reply white. Wide mail gets an in-frame horizontal scrollbar, and the conversation reserves its vertical scrollbar gutter so expanding content does not shift the reader. Bcc appears only on the user's own sent copies — Gmail never exposes other senders' Bcc.
- Bodies for the selected and adjacent conversations are preloaded so opening never shows a spinner.
- **Auto-advance:** after done/snooze/trash, selection (and the open reader) moves to the next conversation automatically (setting: next / previous / back to list).

**Acceptance criteria**
- 60fps scroll while progressively loading through the 10,000-thread performance profile; initial mailbox reads return no more than 100 rows.
- Opening a cached conversation renders in < 50ms; `Esc` returns instantly with scroll + selection intact.
- Auto-advance never lands on a stale (just-triaged) row.
- Every message's full recipient set is inspectable in two interactions or fewer; attachments download to the OS Downloads folder and are revealed on completion.
- Quote/signature collapsing never reduces an all-quote/all-signature message to a blank card, never hides content without a visible expander, and expanding/collapsing is instant (no network) without moving the control or remounting the HTML document.
- Opening by keyboard or pointer transfers reading keys to the conversation. `J`/`K` changes conversation, reading keys scroll, inline controls and HTML-frame focus never strand the keyboard loop, and expanding long content does not horizontally shift the reading surface.
- When the sidebar is expanded, every system mailbox and user label is visible. Collapsing it with the top-bar toggle or `Mod+B` removes the entire sidebar, preserves the active view, and survives relaunch. The title-only view header remains visible so the current mailbox or label is unambiguous. System mailboxes remain reachable by palette and keyboard while the sidebar is closed. Every user label opens from its row or a message-list chip. A cached switch renders in < 50ms, returning restores selection/scroll, and displayed rows match local membership without a network round trip.

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

**Acceptance criteria**
- Any triage action gives visual feedback in < 16ms (optimistic), including on selections of 100+ conversations.
- `Z` fully reverses a bulk archive of 100 conversations, locally and (after sync) server-side.
- `V` moves a bulk selection with one destination choice, and one `Z` reverses every applied thread-label
  delta. For labels that were wholly present or absent, this restores the prior `INBOX` and user-label
  membership. If a target had a pending snooze reminder, Move cancels it and the same `Z` restores its prior
  state and due time.
- Marking a thread important or not important updates `IMPORTANT` through Gmail. Moving into or out of Spam
  and Trash updates `SPAM` or `TRASH` through Gmail. The optimistic row membership matches the chosen action.
- A snoozed thread returns within 60s of its due time while the app runs, or immediately on next launch if it was closed; a reply during snooze surfaces it immediately.
- Snoozed threads are findable in the local "Snoozed" view (`G` then `H`) while the Attn profile exists. Reinstall durability and cross-device visibility are not v1 promises (decision #6).

### F5 — Command palette

`Mod+K` opens the palette from anywhere. It is the app's primary control surface:

- Fuzzy-matches every registered command: triage verbs with arguments ("Remind me tomorrow 9am"), navigation ("Go to Sent"), settings ("Switch theme"), snippets ("Snippet: intro").
- Parameterized commands accept inline arguments with natural-language parsing where applicable (snooze and reminder times).
- Each result shows its keyboard shortcut — the palette is also how users learn the keys.
- Ranking: exact prefix > fuzzy score, with recently/frequently used commands boosted.
- **Engineering rule:** every user-facing feature must register a palette command. No feature ships reachable only by mouse.

The shortcut footer is a context-aware guide. Its default state is a single,
non-wrapping line of only the commands relevant to the active view. Footer hints are explicit command
metadata, not automatic ranking. They favor frequent or view-defining actions, appear only while that
command is registered, and group equivalent keys under one label. The main list orders `J/K` Navigate,
`Enter` Open, `E` Done, `C` Compose, `Z` Undo, `H` Snooze, `V` Move, and `Mod+K` Command palette.
Pressing a chord prefix such as `G` temporarily replaces that line with the visible completions from the
same command registry. The guide shows only the completion keys and labels, without repeating the prefix.
Fixed mailboxes use
`I/A/T/D/S/H/P/R/O`. Inbox splits remain in the command palette and use `Tab` or `Shift+Tab` for direct
navigation. The guide remains visible until completion, `Esc`, a view change, or a 3-second timeout. The
command palette (`Mod+K`) and cheat sheet (`Mod+/`) remain the exhaustive discovery surfaces. Narrow windows
can pan the line horizontally without a native scrollbar changing the footer height.

**Acceptance criteria**
- Opens in < 50ms; results re-rank per keystroke in < 30ms.
- Every spec'd feature in this document is invocable from the palette.

### F6 — Compose, send & undo send

`C` opens new mail in a **full-window focused surface** with a centered 800–900px writing measure. The prior
list or conversation remains mounted but hidden so its selection and scroll are restored exactly when `Esc`
or the visible Back control saves and closes the draft. From a mail list, `R` or `F` opens the selected
conversation directly into its inline reply or forward composer. In the reader, `N`/`P` moves a visible
message cursor without expanding the message, and `O` expands or collapses it. Clicking a message also
selects it. `R`/`A`/`Enter`/`F` replies, replies-all, or forwards the selected message and expands it, with
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
The inline
composer's close button saves the draft and leaves the reader open; `Esc` or the conversation Back control
saves it and returns directly to the originating list in one action. Thread-bound drafts opened from Drafts
return to this same inline context whenever the parent conversation is locally available. While composing, the global mail shortcut
footer is absent and the composer owns its action footer, so editing controls can never overlap global hints.

- **From identity:** every draft belongs to exactly one account, and its read-only From field shows that
  account. New mail binds to the account active when the composer opened; replies, reply-alls, and forwards
  always bind to the account that owns the source thread, whatever account is active. Reassigning a draft's
  account and Gmail send-as aliases remain unsupported in v1 — to write from another account, switch
  accounts first (F18, §9 #21).
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
  Empty editor lines following Gmail's quoted history do not move that history into the editable body or
  trigger a read-only formatting warning. The lines remain in the saved quote. Authored text, images, and
  styled blocks below a quote stay in their original position.
- **Attn signature footer (M4 T32B):** an optional `Sent with Attn` line follows the account's Gmail
  signature, or the authored body when no signature exists, before any quoted history. The setting is
  off by default and applies per account to newly created local drafts in every composer mode. Show the
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
- **Rich text (widened 2026-08-15, §9 #16):** bold/italic/underline/strikethrough, bulleted & numbered lists, links, blockquote, **inline images, tables, font family and size, text and background colour, and alignment** — Gmail's own authoring surface. Pasting an image into the body is supported and travels as a `cid:` inline part. Heading levels are deliberately out: Gmail's composer has none, so they would be a superset rather than parity.
- **Zero formatting loss is an invariant, not an aspiration.** Content Attn's editor cannot represent is preserved byte-for-byte rather than dropped: it renders in place, is not editable inline, and round-trips unchanged through save, Gmail Drafts sync, and send. No draft ever loses formatting by being opened in Attn.
- **Attachments:** drag-and-drop or picker, up to Gmail's 25MB limit, with progress indication. Attached files are copied into a local spool immediately, so a draft is self-contained even if the original file moves or the app force-quits, and that spool remains the source of the bytes for the rest of the draft's life. A forward starts with the source message's file attachments as well as its quoted inline images; the user may remove forwarded files before sending.
- **Drafts:** autosaved to the local store one second after typing stops, and at least every five seconds while typing continues, so a force-quit loses at most five seconds of work. The **Gmail Drafts mirror is a separate, slower schedule** — debounced three seconds after typing stops, skipped entirely when nothing changed since the last push — so a composing session produces a handful of `drafts.update` calls rather than one per second. Drafts are listed in the Drafts view (`G` `D`) and reopenable, and thread-bound drafts are marked on their conversation row. A reply or forward the user never contributed to is **discarded on close, not saved**, matching Gmail: its quote, planned recipients and `Re:`/`Fwd:` subject are Attn's own work, so an untouched one leaves no draft row, no conversation mark, and nothing to mirror. Anything the plan does not write — a body, an attached file, a `Bcc`, a recipient on a forward — makes it the user's and keeps it. Attn's message-specific reply/reply-all entry points share one local reply slot and its forward entry point shares one local forward slot per source message; separately identified Gmail drafts remain distinct even when several belong to the same conversation.
- **Draft sync is two-way (2026-08-15):** drafts written or edited in Gmail appear and open in Attn, and Attn's edits flow back. Conflicts resolve last-write-wins, except that a draft open in the composer always wins over a remote change.
- **A round trip keeps the body and the quoted trail apart (2026-08-16):** Gmail stores a draft as one document, so a reply or forward returns with its quote joined to the body. Attn separates them again on reimport by recognizing the trailing quote structurally — never by matching bytes, since Gmail rewrites markup. Reopening therefore shows the same collapsed quote it showed before the round trip, rather than loading quoted mail into the editor as authored content. Attn declines to split when anything but whitespace follows the quote, because the author typed it there and reassembly always puts the quote last; such a draft stays merged.
- **A mirrored draft is complete (2026-08-16):** attachments mirror with the body, so a draft composed in Attn can be opened and **sent from Gmail web or mobile** with its files intact. Because Gmail replaces a draft wholesale, each checkpoint re-sends every attachment byte; the mirror interval therefore lengthens once a draft carries meaningful payload, while attaching or removing a file still pushes on the normal interval. Bytes stream from the local spool rather than being held in memory, and a file that Gmail echoes back is recognized as the one already held locally rather than stored a second time.
- **Send:** `Mod+Enter`.
- **Undo send:** sending holds the message in a local outbox for a configurable delay (0/**5**/8/10/20/30s, default 5). A queued reply or forward closes the composer and appears in its conversation immediately, without waiting for either the send deadline or a sync poll; that newest message is expanded by default. A toast shows "Sent — Undo (Z)", stays visible for the entire window, and counts down the durable send deadline with a progress bar. Undo removes the queued message from the conversation and reopens the composer with everything intact. The API call happens only after the window elapses.
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

### F7 — Send later (deferred to v1.5)

**Cut from v1** by product decision: a scheduled send must go out at the scheduled time, computer on or off — "sends late on next launch" silently fails the promise made to the recipient, and a feature that can't keep its promise is worse than its absence. The Gmail API does not expose Gmail's native Schedule Send, so exact-time delivery requires something running while the desktop is off (D2).

**v1.5 plan — companion Apps Script (no server we operate):** a small script installed once into the user's own Google account, running on Google's infrastructure as the user. The desktop app writes a normal Gmail draft plus a schedule label (e.g. `[Attn]/SendAt/2026-08-12-0900`); the script sweeps upcoming sends on a time-driven trigger, self-schedules a one-shot trigger per send, and calls `drafts.send` when due. Delivery lands within a few minutes of the target time, and OAuth tokens never leave Google's side. The same script also restores snoozed threads at their exact due time, making snooze returns visible from any device (closing the cross-device gap noted in F4/D2). Reserved keybindings: `Mod+Shift+Enter` (composer), `G` then `L` (Scheduled view).

### F8 — Snippets

Named, reusable text blocks inserted into the composer via palette ("Snippet: …") or a `;shortcut` text trigger typed inline. A snippet may define body text (with an optional `{cursor}` placement marker) and optionally a subject. Managed in Settings.

**Acceptance criteria**
- Insertion < 50ms; `{cursor}` lands the caret correctly; `;trigger` expansion is undoable with one `Mod+Z`.

### F9 — Follow-up reminders

When sending, optionally set "remind me if no reply" (composer control or palette: 3 days / 1 week / custom). If no reply arrives by the deadline, the thread resurfaces at the top of the inbox with a **Follow up** chip. Any reply cancels the reminder. Pending follow-ups are listed in the Snoozed/Reminders view.

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
- Local coverage follows the store: header fields match lifetime mail once the sweep completes; body terms and filenames match only hydrated mail, while `has:attachment` matches lifetime-wide once the ids-only attachment pass that follows the sweep has run (§9 #18c). Local results update as the user types. Enter submits the same query to Gmail (`q=`) once and moves focus to the results; a passive row reports remote progress and failures. Threads fetched from Gmail persist through the normal write path and stay cached. Gmail search is unavailable for Drafts and snooze queries because those are backed by Attn's local outbox and reminder state rather than Gmail search state.
- At large scale, text search considers a bounded recent-match window before filters, and the footer
  identifies partial results. Explicit snooze queries keep older local matches because Gmail cannot
  search local reminder state. A historical sync cap is a separate coverage limit; changing it neither
  removes the search window nor promises exhaustive local results. Search and sync settings explain both
  limits and retain the **Search all of Gmail** action where supported (§9 #22).

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

- Native OS notifications (macOS Notification Center / Windows toast) for new mail in notification-enabled splits: sender + subject + snippet; click opens the thread.
- **Batching:** a poll cycle delivering more than 3 new conversations collapses into one summary notification ("7 new conversations") instead of a burst of toasts. A summary names no single thread, so clicking it raises the window on the inbox rather than opening a conversation — only per-message notifications carry a thread target. Notifications are suppressed entirely while a window is focused.
- Unread badge: macOS dock badge; Windows taskbar overlay. Counts only notification-enabled splits (i.e., the number that matters, not all mail), summed across every signed-in account (F18).
- **Multi-account (F18):** notifications cover every signed-in account, not just the active one. With more than one account signed in, the notification names the owning account; batching applies per account per poll cycle; and clicking a notification switches to that account before opening its thread (or its inbox, for summaries).
- Pause notifications for one hour or until tomorrow, or resume, from settings and the palette on either
  OS. The existing tray actions use the same app-wide deadline. Pausing suppresses notifications for all
  accounts without changing their split settings, unread badges, or background sync.
- Notification latency is bounded by polling: ≤ ~30s foregrounded (D2).
- **M1 staging:** before splits exist, notifications and the badge cover every unread Inbox conversation. Windows uses a static-dot overlay with the numeric count in its tooltip. Per-split filtering arrives with F11 in M3; a rendered Windows numeric overlay is M4 packaging polish.

### F13 — Inbox zero

When a split reaches zero, the list pane is replaced by a full-pane zero state: a rotating background image, a short affirmation, the time, and a hint of remaining splits with total conversation counts ("Other: 12 total"). Split-strip badges continue to show unread counts. Reaching zero should feel like a reward.

### F14 — Themes

Attn ships four curated palettes: Dark, Light, Midnight, and Sand. The default System preference follows the
OS and resolves to the dark/light pair; selecting a named palette pins it
regardless of OS changes. Theme choices are available from the account menu and as palette commands. User-
customizable palettes and accent colors remain post-v1. Every built-in uses D6's semantic token names rather
than component-level color branches.

All UI, including rendered HTML mail, must be legible in every palette. Light palettes evaluate color-scheme
rules as light and preserve sender foreground and non-neutral canvas colors. Native mail clears neutral
background patches so its text sits on the selected palette, while constrained sender-designed canvases are
centered on a solid light mail surface. Dark palettes keep the safe background
normalization that `mailSurface.ts` applies today, with a per-message "View original" escape hatch.

### F15 — Settings

Settings and the palette expose:

- Accounts: live sync status, add, reconnect, Sign out with Delete/Keep local data, and reorder for
  `Mod+1..9` (F18). Reuse the existing account-management guards and deletion-failure warning.
- Sync & storage: the active account's historical conversation limit, with default, custom, and All mail
  choices (F2). This control does not evict cached mail or change body windows and search limits.
- Triage: undo-send delay and auto-advance direction.
- Compose: per-account **Include "Sent with Attn"**, off by default, with a preview and a note that the
  choice affects new drafts only (F6). The palette offers the same enable/disable action.
- Notifications: one app-wide pause/resume deadline and per-account split notification controls.
- Snippet manager, split-rule manager, and theme.
- Background behavior: launch at login and the optional macOS menu-bar icon (F16).
- AI writing: enable, provider and key, voice profile, and separate autocomplete opt-in (F17).
- Keyboard cheat sheet (`Mod+/`).

Label account-specific controls with the owning email; other preferences apply app-wide. Settings reuse
the existing default constants and typed APIs. Internal polling, quota, paging, retry, search-window, and
editor-timing constants remain development tuning rather than user controls.

**Entry point (D6):** the account chip in the top bar is the menu — the signed-in accounts with the active one marked (F18), Add account…, Settings (`Mod+,`), Keyboard shortcuts (`Mod+/`), Split rules, Sign out. No hamburger icon; every item is also a palette command.

### F16 — Background & tray behavior

The app is present whenever the machine is awake, so snooze timers, polling, and notifications keep working (D2):

- **Windows:** closing the window hides to the system tray. The tray icon is always present while running; its menu offers Open Inbox, Compose, Pause notifications (1h / until tomorrow), Quit. Double-click reopens the window.
- **macOS:** closing the window leaves the app running (Dock and `Cmd+Tab`, standard platform convention). An optional menu-bar icon (default off) mirrors the tray menu. `Cmd+Q` / tray **Quit** exits fully on both platforms.
- **Launch at login** (default on) starts the app in the background — no window flash; the window appears on demand.
- While backgrounded: polling at the 60s cadence, notifications fire, badges update.

**Acceptance criteria**
- Closing the window never stops snooze timers, polling, or notifications.
- Quitting (tray menu / `Cmd+Q`) stops everything — no orphaned background processes.
- Login launch is windowless and adds < 1s to login.

### F17 — AI reply drafting and inline autocomplete (opt-in, bring-your-own key)

**Off by default.** Enabling requires the user's own API key — an Anthropic key or any OpenAI-compatible endpoint (which also covers fully local models via Ollama / LM Studio for a zero-cloud setup). Keys live in `safeStorage`; requests go **directly from the client to the chosen provider**, no intermediary (consistent with D2). Provider-agnostic; model user-selectable with a sensible default per provider.

**Reply drafting:**

- **Draft reply** (`Mod+J`, also a palette command): generates the whole reply body for the open thread, streamed into the composer as a fully editable draft. Available from the reader or a reply/reply-all composer; full-message generation for new mail and forwards is outside v1.
  Generation, refinement, and undo affect the authored reply region above the signature. Preserve the
  Gmail signature and optional Attn footer, including user edits or removal (F6).
- **Voice profile:** tone preset (concise / friendly / formal) plus free-text standing rules ("sign off with 'Best, Chao'", "never use exclamation marks").
- **Voice matching:** a handful of the user's recent sent replies from the draft's owning account, selected locally, accompany the reply request as style examples (toggleable). Autocomplete never includes these examples.
- **Inline refine:** after a draft lands, a one-line instruction ("shorter", "more formal") regenerates it.

**Inline autocomplete:**

- A **separate, default-off setting** enables short suggestions while typing in new messages, replies,
  reply-all, and forwards. Enabling reply drafting does not enable autocomplete. It uses the configured
  provider and model; cloud suggestions can incur repeated API charges. Local endpoints remain supported.
- After a pause in typing, show one short continuation in gray at the caret, with no line breaks and at
  most 120 characters. This suggestion is a preview outside the saved editor document; it never enters
  autosave, Gmail draft mirroring, copied mail text, or the outbox until accepted.
- `Tab` accepts a visible, current suggestion only while the body editor has focus. The accepted text is
  editable and one undo step; undo restores the previous text and caret. `Esc` dismisses the suggestion
  without closing the composer. Continuing to type dismisses it and can request a fresh suggestion after
  another pause. With no suggestion, normal `Tab` focus and `Esc` close behavior remain. `Shift+Tab`, arrow
  keys, and `Enter` keep their existing behavior; recipient completion, menus, and snippet pickers take
  precedence in their own contexts.
- Only deliberate typing in the focused body of the foreground composer can trigger a request. Opening,
  restoring, or focusing a draft does not. Suppress suggestions during IME composition, non-collapsed
  selections, reply generation/refine, and editing of quotes, signatures, tables, or preserved opaque
  content.
- Edits, caret/selection changes, blur, closing or sending the draft, account changes, and AI configuration
  changes invalidate pending and visible suggestions. Late results can never insert into another draft
  or account, and dismissing or accepting a suggestion does not itself request another.

**Privacy and request limits:**

- Full reply generation and refine run only on explicit invocation. Separately enabling autocomplete
  permits requests while actively typing; it does not permit background mailbox processing.
- The reply enable screen discloses the current thread, voice profile, and optional style examples sent
  on each invocation. The autocomplete opt-in separately discloses that **unsent draft text leaves the
  machine while typing** when using a cloud endpoint. Its payload contains only a bounded plain-text
  excerpt of the authored body around the caret: at most 2,000 characters before and 500 after. Exclude
  thread history, quoted mail, signatures, recipients, subject, attachments, and sent-mail examples. Do not
  read other messages to enrich autocomplete context, even with voice matching on.
- Debounce autocomplete by 300ms; allow at most one autocomplete request in flight app-wide, no more than
  one start per second and 20 per rolling minute. Skip requests when limited; do not queue or retry them
  automatically. Cancel and discard results more than 1,500ms after dispatch. Slow, offline, or failed
  providers leave typing usable without recurring error toasts. Settings still expose configuration errors.
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
  contains only the bounded authored-body excerpt regardless of that toggle.
- A generated reply and an accepted suggestion are each undoable as one edit. No unaccepted suggestion
  appears in a saved, reopened, mirrored, or sent draft.
- Fake-provider tests prove debounce, request caps, timeout, IME suppression, keyboard precedence, and
  rejection of stale results after editing, switching drafts/accounts, closing, sending, or disabling.
- Settings and palette commands expose autocomplete enable/disable; the cheat sheet explains `Tab` and
  `Esc` in the body editor. Suggestions remain legible in all four built-in themes without moving focus.

### F18 — Multiple accounts

Attn signs into several Google accounts at once and treats each as its own complete mailbox. One account is
**active**; everything the UI shows — list, reader, composer, search, palette, sidebar labels and counts,
splits, Snoozed, Outbox, Drafts — belongs to it. Switching accounts swaps that entire surface in place.
There is no unified inbox in v1 (§2) and no view ever mixes two accounts' rows.

- **Add account:** the account menu and palette offer *Add account…*, running F1's OAuth flow. Signing into
  an already-added address refreshes its tokens instead of duplicating the account. There is no hard account
  cap; the switcher digits cover the first nine.
- **Reorder accounts (M4 settings):** change menu and `Mod+1..9` order without changing the active account,
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
  and asks what to do with local data (decided 2026-08-28). Confirming always removes the account's tokens
  and stops its sync. The default, **Delete local data**, purges every local trace —
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
| `Tab` / `Shift+Tab` | Next / previous Inbox split, wrapping at both ends; `Tab` returns to Inbox from another mailbox (M3) |
| `←` / `→` | Previous / next Inbox split aliases (M3) |
| `X` | Select conversation (`Shift+J/K` or `Shift+↑/↓` extends) |
| `G` then `I` | Go to Inbox |
| `G` then `A` | Go to All Mail |
| `G` then `T` | Go to Sent |
| `G` then `D` | Go to Drafts |
| `G` then `S` | Go to Starred |
| `G` then `H` | Go to Snoozed / Reminders |
| `G` then `P` | Go to Spam |
| `G` then `R` | Go to Trash |
| `G` then `O` | Go to Outbox (the on-demand local view of queued/sending/failed/needs-review sends, F3/T16) |

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
| `R` / `A` or `Enter` / `F` | Reply / reply-all / forward |
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
| `Tab` | Accept a visible autocomplete suggestion in the focused body; otherwise normal focus behavior |
| `Esc` | Dismiss an autocomplete suggestion or cancel AI streaming first; otherwise close (draft saved) |

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
                             Gmail API only
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
  utility; broadcasts and reads are tagged with their owning `account_id`, and the renderer remounts its
  mail tree on switch rather than threading an account id through every call.
- **One reducer, two sources:** server history events and local optimistic actions flow through the same state-transition code, which is what keeps optimistic UI and sync convergent.
- **Scheduler** owns every timer (snooze due-times, follow-up deadlines, undo-send windows); on launch it executes anything that came due while the app was closed (catch-up, D2).

**Target v1 local schema (core tables; see §8 for shipped status):** `accounts`, `threads`, `messages` (bodies, recipients, attachment metadata), `bodies` (FTS5 external-content), `labels`, `thread_labels`, `contacts` (with frequency/recency stats), `split_rules`, `split_config`, `snippets`, `reminders` (snooze + follow-up), `outbox`, `action_queue`, `sync_state`, `settings`. Every row keyed by `account_id` (D4).

**Security & privacy:** OAuth tokens (one set per account, F18) and LLM API keys via `safeStorage` (Keychain/DPAPI); DB under the OS user profile; TLS to Google only — plus the opt-in LLM provider (F17), which receives content on explicit reply-generation/refine commands or, under a separate opt-in, bounded unsent draft text while typing. No background mailbox processing. **No telemetry, no other third-party services** in v1. Remote images in HTML mail load directly (no proxy without a server, D2), with a global "block remote images" toggle and per-sender overrides — default is load (decision log, §9).

**HTML mail rendering:** sanitized (DOMPurify-class allowlist), rendered in a sandboxed `<iframe>`/webview with no script execution, links open in the system browser. Some legitimate senders serve images with `Cross-Origin-Resource-Policy: same-origin`, which Chromium would block inside that frame; the app removes only that response header, only for image requests originating from the mail frame — no other request or header is modified. The frame is measured after load and on resize, preserves horizontal overflow inside the frame, and remains mounted when quote/signature visibility changes. A shared surface classifier gives fallback content and HTML without a non-neutral authored canvas the native Attn treatment; non-neutral backgrounds and background images keep a light document canvas. Native mail clears sender background patches in every palette. It keeps authored inline text colors in light palettes; in dark palettes it adjusts chromatic colors to readable contrast and replaces low-contrast neutral foregrounds with the native default. Constrained sender canvases center within a solid light mail surface. Typography, media, tables, layout attributes, and layout-only CSS are not canvas evidence. The composer quote preview uses the same decision. Filename-bearing MIME parts count as attachments whether Gmail supplies an attachment ID or inline base64url data. The stored `inlineData` field is withheld from `ConversationMsg`, and inline-delivered attachments can download without a network request. For `cid:` rendering, however, `mail:getInlineImage` deliberately sends matching image content through the typed preload bridge as an allowlisted-MIME base64 `dataUrl`, capped at 25 MB; the renderer assigns that value to the image in the scriptless mail iframe. A direct MIME Content-ID match takes precedence, with a unique CID or `alt` filename accepted as a compatibility alias when sender HTML and MIME generated different identifiers. Ambiguous and unresolved references remain inert broken-image placeholders.

**Packaging:** `electron-builder`; auto-update via GitHub Releases. macOS notarization + Windows code signing required for public distribution (skippable for personal builds). *Status:* personal-build packaging shipped early, at M1 exit — a manually dispatched GitHub Actions workflow produces macOS DMG/ZIP for both architectures (ad-hoc signed) and a Windows NSIS installer (unsigned), each verified by `npm run package:verify`. Auto-update and real signing/notarization remain M4.

M4 keeps personal packaging available without signing credentials and disables its updater, even when
packaged. Public-release builds require explicit release metadata and signature verification. Automatic
updates stay within the installed database's schema version, using separate feeds and matching schema
metadata checked before download and installation. Missing or incompatible metadata rejects the update
without replacing the app or changing local data. A schema-changing release needs a separate upgrade
procedure; auto-update never deletes a profile or adds a runtime compatibility-migration framework.

**Testing:** unit tests on the reducer/sync engine (the correctness core — replay recorded history streams), command-registry tests (every command has a handler + palette entry), Playwright smoke e2e (sign-in stubbed, triage loop, compose/send against a mock provider).

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

The dedicated Electron performance job now drives a 10,000-thread production build on every pull request. It enforces a windowed DOM, p95 scroll-frame pacing, the 500 MB application-owned memory ceiling, cached conversation open, single/bulk triage feedback, and composer open/mutation/paint budgets. The 2026-08-19 local profile is recorded in docs/T20-EVIDENCE.md.

Initial sync is measured at both completion points above: time to interactive-ready is a product budget;
time to finish background indexing is reported with mailbox size, stage request counts, effective
threads/minute, and quota-wait time. A single wall-clock target for full indexing would be misleading across
mailboxes and Gmail quota regimes. Background work must preserve every interaction budget in this table.

Autocomplete must preserve the composer budget while a provider is slow or unavailable. F17 bounds request
frequency and discards responses after 1,500ms; provider latency is measured separately from local editing
latency and is not a prerequisite for typing, saving, or sending.

---

## 8. Milestones

PR #96 review follow-up (2026-08-30): M5 now cancels reads from removed accounts, guards the
removal transition against composer opens, restores split and paginated selections, and keeps open
account-menu statuses current. Regression coverage and implementation notes are in
[M5 A3 and A6](M5-PLAN.md).

Each milestone ends in a usable app; the daily-drivable bar is M2.

**Status (2026-08-28):** all planned M1 feature capabilities are implemented. The engineering exit audit and real-Gmail airplane-mode drain are complete; only the real-OS notification click-through smoke in docs/M1-PLAN.md remains. M2's feature work has shipped: the renderer decomposition (#31), main-process seams (#30), mail-out test scaffolding (#37), sent-mail/contact foundation (#32), full-window composer with crash-safe drafts (#38), MIME builder and reply semantics (#39), on-demand body hydration (#41), drafts as first-class objects with reply/forward entry points, rich content with the zero-loss invariant, and two-way Gmail Drafts sync (#43, #44), outbox send and undo send (#45), self-healing failed actions (#47), outgoing attachments (#48), inline thread drafting (#50), the lifetime header sweep plus the full bounded stage pipeline pulled forward from M3 (#51), and the composer dogfood fixes (#52). T21's poll-cycle label-catalog refresh is implemented with authoritative replacement and change-only UI invalidation. T20's engineering pass ships 10k list windowing and regression budgets; M3 navigation now feeds those lists with 100-row keyset pages instead of transferring the full profile at once. Composer profiling, the weighted Gmail quota limiter, and first-readable/stage/rate/quota-wait telemetry remain recorded in the [T20 evidence](T20-EVIDENCE.md). Still open before M2 sign-off are the real-Gmail bootstrap/exactly-once/hydration observations, real-OS notification click, and the one-week sole-client dogfood run recorded in docs/M2-PLAN.md. Multi-account was pulled into v1 scope on 2026-08-28 (F18, §9 #21) as milestone M5; its switch-account slice (A1–A3: add account, switcher via menu/palette/`Mod+1..9`, per-account sync sessions with background polling for inactive accounts, per-account sign-out) landed the same day, and the remaining feature work (A2 liveness proofs and indexing-slot preemption, A3 per-account view restore and menu status, A4 cross-account notifications and focus routing, A5 per-account composer/outbox/reconnect correctness, A6 remove account with Delete/Keep local data, A7's executable isolation sweeps and the two-account perf profile) landed 2026-08-30 — docs/M5-PLAN.md records each task's as-shipped shape; only A7's real-Gmail two-account dogfood observation remains before M5 sign-off.
- **M0 — Walking skeleton.** Electron shell (both OSes), Google OAuth, metadata backfill into SQLite, read-only list + reading view, `J/K/Enter/Esc`. *Proves: auth, sync, and the 60fps list.*
- **M1 — Triage core.** First items: **apply the Dispatch direction** (D6 — graphite/amber tokens, `attn:` wordmark, layout per D6, split strip, account menu) and **sanitized HTML mail rendering** (allowlist sanitizer + sandboxed iframe per §6 — triaging means reading real mail; M0 shipped plain-text bodies only). The reading work adds recipients, attachments, quote/signature collapse, and—after M1 dogfood—the full-window conversation that supersedes the interim split. Then: done/snooze/trash/star/unread/label, selection + bulk, auto-advance, `Z` undo, durable action queue + offline replay, snooze scheduler, tray/background mode + launch at login, basic notifications. *Proves: the core loop and offline correctness.*
- **M2 — Mail out.** Composer (rich text, attachments, recipient autocomplete), reply/all/forward, crash-safe drafts, send + undo send, exactly-once outbox. **← daily-drivable.**
- **M3 — Find & focus.** Opens with the sync restructure planned as S1–S4 in docs/M3-PLAN.md. The all-mail and spam-trash backfill stages and per-label membership reconciliation (S3 and half of S4) shipped early, in M2's #51. Per-message label storage followed in S2, the utility-process move landed in S1, and S4 completed expired-history tombstoning. The sync restructure is done. T22 shipped local system mailbox navigation, unconditional list windowing, per-view selection/scroll restore, and trashed-message reader markers. Its 2026-08-24 navigation follow-up replaced the shifting header menu with a persistent mailbox/label sidebar and added local user-label list views. T23 shipped the FTS5 message index with its transactional write paths and resumable backfill cursor, T24 shipped local search UI and operators over that index, T25 shipped Enter-submitted Gmail search with durable on-demand thread caching, T26 shipped the context-filtered command palette and `N`/`P`/`O` reader keys, T27 shipped configurable split Inbox views and per-split notifications, T28 shipped the contextual chord guide with one 3-second dispatch window, T29 shipped the local rotating inbox-zero reward guarded by completed Inbox body and split-metadata checkpoints plus recovery state, T30 shipped the built-in themes, and T31 shipped one-shot Move with mailbox, split, bulk, and snooze-aware undo behavior. The planned M3 feature tasks are complete.
- **M4 — Power finish.** Snippets, follow-up reminders, the optional "Sent with Attn" signature footer (F6), AI reply drafting and inline autocomplete (F17), settings surface, badge polish, auto-update + signing/notarization (personal-build packaging shipped early, at M1 exit — §6 Packaging). Task plan: docs/M4-PLAN.md.
- **M5 — Multi-account (F18, added 2026-08-28, §9 #21).** Move the auth/token layer, sync sessions, executors, notifications, and the renderer shell from "the account" to "the active account among N" per docs/M5-PLAN.md: add/switch/reorder/remove accounts, background liveness for inactive accounts, cross-account notification routing, and per-account isolation guarantees. Its tasks touch none of M4's feature surfaces, so the two milestones may interleave, but v1 does not ship before both exit. *Proves: D4's account-keyed store was real.*

**Post-v1 sequence:** v1.1 — global-hotkey quick panel (quick compose + quick search) and custom themes (user token sets over D6's semantic names); multi-account moved into v1 (§9 #21). v1.5 — companion Apps Script: send later + exact-time snooze return (F7). v2 — hosted backend: read statuses, true multi-device state, unified inbox candidate.

**Success metrics (post-M2 dogfood):** p95 action latency vs. budget, % of actions invoked via keyboard (target > 80%), time-to-zero on a 50-conversation morning inbox (target < 15 min), crash-free sessions > 99.5%.

---

## 9. Decision log (1–6 resolved 2026-08-09; later entries dated inline)

1. **Multi-account:** not in v1. Moved out of the M4 stretch into v1.1, alongside the quick panel. Data model stays multi-account-ready (D4). *Superseded by #21 (2026-08-28): multi-account moves back into v1 as M5.*
2. **OAuth distribution:** dev-mode for v1 — each user supplies their own Google OAuth client; Google verification deferred until/unless a public release (F1).
3. **Read statuses:** out of v1; revisit at v2 with the hosted backend (D2).
4. **Shell:** Electron confirmed over Tauri — one rendering engine and one language outweigh Tauri's footprint advantages for this app (D3).
5. **Remote images in HTML mail:** default load, with the global block toggle and per-sender overrides (§6 Security).
6. **Snooze reinstall durability (updated 2026-08-12):** accepted — v1 snooze state is local-only. A reinstall loses due-times and cannot distinguish those archived threads from ordinary archived mail. The v1.5 companion script adds Gmail-side labels and exact-time restoration; v1 does not claim cross-device visibility or reinstall recovery.
7. **Conversation layout revised (2026-08-11; superseded by #11):** v0.7's centered overlay didn't hold up for reading, so M1 first moved to an on-demand split. Decision #11 records why that intermediate layout was later removed.
8. **Push vs polling (2026-08-11):** polling stands for v1. Gmail push means `users.watch` → Cloud Pub/Sub → a public HTTPS webhook — a server, which D2 rules out. The serverless workarounds were weighed and rejected: desktop Pub/Sub *pull* needs each user's own GCP project (topic, publish grant to Gmail's push service account, daily `watch` renewal) — past the dev-mode onboarding ceiling; IMAP IDLE needs the full `https://mail.google.com/` scope (broader than `gmail.modify`) plus a second protocol stack maintained as a wake signal. Polling at 15s/60s meets F12's ≤30s latency bound at negligible quota (`history.list` = 2 units/call). Revisit with the v2 hosted backend.
9. **Reading interaction refined (2026-08-11; updated 2026-08-25):** real-mail dogfood replaced F3's fixed ~720px reading column and detached quote controls with a responsive measure and an inline, position-stable `...` boundary control. The measure was narrowed by 20% to 576–896px after wider mail proved harder to scan. HTML-mail overflow stays inside the message frame, while a stable outer scrollbar gutter prevents reader-width jumps. PR #23 makes expanded-message collapse and keyboard continuity across Tab stops explicit. The split-specific focus behavior from this iteration is superseded by #11.
10. **Mailbox navigation is explicit v1 scope (2026-08-11; revised 2026-08-25):** Important/Other are Inbox splits, not substitutes for Gmail's system mailboxes. M3 adds local-first Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, and Trash filters in the existing list/reading shell. The first implementation used a header menu plus palette commands and `G` chords to avoid a sidebar. Dogfood showed that the header moved between destinations and left user labels without a browsing surface. A stable left sidebar now holds system mailboxes, Outbox, and user labels. A second dogfood pass removed the misleading loaded-row count while retaining a compact title-only header so the active destination remains clear when the sidebar is closed. Palette commands, `G` chords, and `Mod+B` for the sidebar remain keyboard alternatives.
11. **Full-window reading replaces the split (2026-08-12):** showing the compact queue beside the message made reading more distracting and introduced an invisible list/message focus mode. Attn returns to D5's one-clear-focus principle: opening replaces the list with a full-window reader, `J`/`K` always changes conversation, dedicated reading keys scroll, and `Esc`/Back restores the preserved list. Neighbor preloading retains preview-like speed without simultaneous panes. The split is not kept as an option in v1 because that would preserve two interaction models through composer and command-palette work.
12. **Sync status is a product surface (2026-08-13, PR #25):** local-first deliberately hides the network, which also hid real failures — a missing OAuth config or expired history checkpoint previously failed silently while the inbox quietly went stale. The footer now always shows Live/Checking/Syncing/Offline/Error (F2 "Sync visibility"), with stage-granular backfill progress and retry/copy actions on error. Offline is deliberately calm — local mail keeps working and retry is automatic; error is deliberately loud. The same PR made the backfill itself staged and resumable (metadata → bodies → reconcile with per-page cursor checkpoints).
13. **Full-window new mail plus inline thread drafting replaces the docked overlay (2026-08-14, revised 2026-08-15):** the bottom-right panel made writing feel secondary and could collide with the global shortcut footer. New mail owns the active window at a centered writing measure, preserves the hidden list/reader state, and restores it on `Esc`/Back. Reply, reply-all, and forward instead compose as the final card beneath the source conversation, matching the contextual model used by Gmail and Superhuman. Both modes own their action footer and replace the global mail footer while active.
14. **The shortcut footer becomes a contextual chord guide (2026-08-14; revised 2026-08-28):** default hints stay minimal and view-specific. A prefix such as `G` temporarily shows the fixed mailbox letters from the command registry. Split navigation uses `Tab` and `Shift+Tab`; split commands remain in the palette. The palette and cheat sheet remain the complete references. Implementation is an M3 follow-up, separate from composer work.
15. **Lifetime contact indexing is decoupled from mail history (2026-08-14):** the recent Sent window makes autocomplete useful quickly, then a resumable low-priority header-only pass derives recipients across lifetime Sent without cloning old bodies or creating old browsable mail rows. Importing saved Google Contacts remains a separate OAuth/product decision.
16. **The composer's narrow schema is reversed for zero-loss editing (2026-08-15):** M2's composer deliberately shipped a minimal node set (bold/italic/underline, lists, links, blockquote) so output would be predictable and pasted junk would be rejected by construction. The narrowness lived in two places we control, neither of them a Lexical limitation: the registered node list in `editorConfig.ts` and the outgoing sanitizer allowlist in `composer/sanitize.ts`. Dogfood rejected the consequence rather than the reasoning: a client that cannot paste an image, and that silently flattens a Gmail-authored draft when you open it, is not a Gmail replacement. Two changes follow. The editor widens to cover what Gmail's own composer emits — inline images, tables, font family and size, text and background colour, alignment, and strikethrough (heading levels are excluded, since Gmail has none) — and anything still outside that set is **preserved byte-for-byte as an opaque region** rather than dropped, so "no formatting loss" becomes an invariant that holds for arbitrary HTML instead of a promise that holds until someone pastes something unusual. The original rationale is retained where it still applies: outgoing content stays untrusted and is still sanitized (M2 global rule 3), the sanitizer's allowlist widens deliberately rather than becoming permissive, and preserved regions are rendered through the same scriptless path as incoming mail. Cost is accepted knowingly: this expands M2 beyond composer-and-send, and F8 snippets and F17 AI drafting must now target a richer document model.
17. **Lifetime headers replace the 12-month metadata window (2026-08-15; quota corrected 2026-08-19; M3 sync completed 2026-08-22):** v0.13's 12-month window was a scoping decision, not an architectural constraint, and it quietly broke three product promises — search recall (mail archived before install was invisible even when weeks old, because backfill was Inbox-scoped), contact autocomplete beyond a year, and complete system mailboxes. Headers are cheap in storage (~1–2 KB) but, under Google's post-May-2026 table, cost 40 quota units per `threads.get` plus amortized listing cost; a 60k uncached sweep has a theoretical quota floor around 6.7 hours at the default 6,000 units/user/minute, before the accepted interactive reserves and background pauses. Bodies and attachments remain orders of magnitude heavier, so v0.15 retargets the store at **lifetime headers, windowed + on-demand bodies** (D5, F2). The backfill becomes priority-ordered stages over one idempotent walk — inbox → bodies → drafts → all-mail 12m → spam-trash → reconcile → lifetime sweep — where every stage skips already-stored threads, consecutive slices overlap rather than carving Gmail's fuzzy date-operator complements (a seam gap loses mail silently; overlap costs ~1% in listing), and a stage boundary exists only where behavior changes (priority, throttle, or what runs next). Recorded consequences: `threads.list` excludes SPAM/TRASH unless asked and Gmail purges both at ~30 days, so those stages are explicit and inherently small; SPAM/TRASH messages are excluded from contact statistics; per-message label storage is required once Trash is local, because a thread-level label union cannot express a partially-trashed thread; the poller refreshes `labels.list` each cycle because history never reports label create/rename/delete; and `historyId`-expiry recovery reconciles every cached system label and removes server-purged threads only after a complete account existence listing identifies candidates and direct per-thread fetches return 404. T13A shipped the lifetime sweep and contact derivation in M2, superseding #15's Sent-only pass. The all-mail/spam-trash stages shipped in #51; S2 added per-message labels, S1 moved SQLite and sync into the utility process, and S4 completed recovery reconciliation and tombstoning. Deliberately still not fetched: People-API contacts (#15), custom send-as aliases, Gmail's separate reply and forward signature-default choices, Gmail-native snooze (not exposed by the API), filters/vacation/forwarding settings, confidential-mode bodies (the API returns placeholders), and legacy Hangouts `CHAT` rows (skipped defensively). The sender reads the primary send-as display name and signature through the existing `gmail.modify` scope. Outgoing mail therefore carries the configured `From` identity, and every local Attn composer starts with the last fetched primary signature.
18. **Post-M2-review product calls (2026-08-17):** (a) **Legacy table presentational attributes join the zero-loss scope** — *shipped in #55* — `align`/`valign`/`bgcolor`/`width`/`height`/`border`/`cellpadding`/`cellspacing` on `table`/`tr`/`td`/`th` must round-trip instead of being silently dropped by the import sanitizer; until the editor can represent them, a table carrying them is preserved whole as an opaque region (byte-exact, not editable inline) rather than editable-but-stripped. (b) **Forward threading is verified on real Gmail:** a forward carries only `threadId` plus the `Fwd:`-prefixed subject (no reply headers, `replyPlan.ts`), and an owner test shows it lands in the source conversation — T14B/T16's open observation is closed. (c) **The lifetime `has:attachment` walk is approved** — *shipped in #56, `sync/attachmentFlags.ts`, schema revision 15*: an ids-only `q=has:attachment` listing pass (~1% of sweep cost) sets thread-level attachment flags lifetime-wide, so attachment chips and local `has:attachment` search are trustworthy before hydration. (d) **`N`/`P`/`O` reader keys stay in §5** — *shipped in T26*: `N` and `P` move the active message without changing its expansion state, and `O` expands or collapses that message. The M3 palette-completeness assertion covers all three commands.
19. **The utility process owns SQLite (2026-08-22):** §6 commits M3 to running Gmail fetch, backfill, derived-data rebuilds, and FTS indexing in a utility process. S1 moved the sole SQLite connection, every local read, sync, action replay, draft mirroring, outbox sending, and schedulers into that process. Main has no fallback database handle. The action and send state machines live beside their durable rows, so an IPC reply cannot split an executor from its committed state. Every renderer read is a two-hop round trip; the post-move 10,000-thread profile measured cached conversation open at 5 ms p95, local mail refresh at 37 ms p95, and application-owned steady-state memory at 130 MB. The supervisor restarts a crashed utility without restarting the app, and each indexing cursor resumes from SQLite. See docs/S1-DESIGN.md and M3's S1 in docs/M3-PLAN.md.
20. **Move is separate from Label (2026-08-27; revised 2026-08-28):** `V` chooses one mailbox or user-label destination. Done represents All Mail without `INBOX`, `SPAM`, or `TRASH`. In Inbox, the same picker separates **Mark as important** and **Mark as not important** under Importance because Gmail's `IMPORTANT` mutation can reclassify a thread without naming its resulting split. `L` remains the multi-label membership editor. Move preserves unrelated labels and status flags, removes the active user label when invoked from that label's view, and calls Gmail `users.threads.modify` with the planned system-label delta. The `!` and `#` shortcuts share the same Spam and Trash system-label plans, Gmail operation, and optimistic renderer path; support for older queued `threads.trash` and `threads.untrash` rows remains until those rows drain. A pending-snooze thread reached through another view is movable. Move cancels its reminder, and undo restores the reminder with its prior due time. Drafts, Snoozed, and Outbox retain their dedicated actions.
21. **Multi-account moves into v1 as switched accounts (2026-08-28; revises #1 and D4, adds F18 and M5).** Dogfood reality: one mailbox is not how the maintainer lives — work and personal Gmail both need triage, and a client that owns only one of them keeps Gmail web open, which defeats the daily-driver goal. The store was built for this from day one (every row keyed by `account_id`, D4), so the cost concentrates in the places that assume "the account": the single-`TokenSet` token file, main's sign-in-replaces-account flow and global auth generation, the singleton sync session in the utility runtime, executors that drain only the current account, the single-account notifier gate, and the renderer's `status.email`. Shape decisions recorded now: (a) **switched accounts, not a unified inbox** — one active account renders at a time, because a merged list reopens every per-account invariant (splits, counts, search scope, triage targets, From identity) for marginal v1 value; (b) **inactive accounts stay fully live** — poll at the 60s background cadence, drain action/outbox/draft queues, fire snooze returns and notifications — because an account that freezes when backgrounded is a profile, not an account; a queued send or snooze return that silently waits for a switch would break F6/F4's promises; (c) **each draft belongs to one account** — new mail binds to the account active at open, replies and forwards to the thread's owner, no From picker in v1 (F6); (d) **Remove account always removes tokens and asks about local data** (updated 2026-08-28): the default purges every local trace — rows, FTS entries, spool files, reminders, per-account settings — because local data is a cache of Gmail (decision #6's posture) and removal is the privacy boundary, while an explicit Keep choice preserves the rows dormant so re-adding the same address resumes from stored cursors instead of re-backfilling; (e) **notifications and the badge span all accounts** and clicks route through an account switch (F12); (f) **search and contact autocomplete stay account-scoped** (F10); (g) **historical indexing serializes across accounts** (active account first) while pollers, executors, and interactive work run concurrently for all — adding an account must never starve triage or another account's correctness work, and the lifetime sweep is the only unbounded quota consumer; (h) **the IPC surface keeps the account implicit** — the utility owns the active-account pointer, and threading an explicit account id through every one of ~60 channels buys nothing while a single-window app shows one account at a time. *As shipped (2026-08-28):* the utility goes one step further and filters renderer-facing broadcasts to the active account instead of tagging them — equivalent isolation with nothing on the wire to mis-filter — while events that are genuinely per-account (`token-update`, `actions-reverted`, `body-hydration-failed`, notification candidates) carry `account_id`; the switch itself resolves as a request/response through the utility so every later read is answered for the new account, and the renderer remounts the mail tree keyed by account (PR #94 review) so the first frame for the new account can never carry the previous account's rows. Sub-decisions still awaiting product sign-off are listed in docs/M5-PLAN.md §Open decisions; each names the default the spec assumes so a reversal is one bounded edit.
22. **Mailbox-size posture: smooth at ordinary scale, degraded but not broken at extreme scale (2026-08-29):** §7's budgets are written against 50,000 messages, while §9 #17 deliberately targets lifetime headers, so the store can hold far more than the budgets describe. A synthetic probe (docs/T20-EVIDENCE.md, 2026-08-29) found the ceiling was three query shapes rather than sync completeness: mailbox counts, search coverage, and an unbounded search candidate set, all of which scaled with the account instead of the answer. The decision is that Attn targets **smooth operation to roughly one million messages** and **degrades rather than breaks beyond it**, with T25's "Search all of Gmail" serving the tail that local search bounds away. Consequences, all shipped with this entry: mailbox counts are exact and read a derived membership table rather than scanning membership rules; counts are cached between writes on the utility process's single SQLite connection, including background writes that do not broadcast a mail change; search coverage reads the current sync cursors without scanning messages. Local text search considers a bounded window of the newest matching messages and says so in the results footer when that window fills, because an empty result under a filter is otherwise indistinguishable from "no such mail". Explicit snooze searches bypass that window because Gmail cannot search local snooze state. The sweep enforces the target rather than only describing it: it keeps the newest `LIFETIME_THREAD_CAP` conversations (400,000, about a million messages and roughly 48 hours of app-open fetching at Gmail's background quota) and leaves older mail to server search, which the search field advertises on every local result. Raising the cap resumes the walk; lowering it stops fetching and deletes nothing. Every such knob lives in `src/main/sync/tuning.ts`. Deliberately not done: exhaustive search past the window (the server answers that), and a user-facing control for the cap, planned per account in F2/F15 and M4 T32A. E7's real-Gmail bootstrap capture remains open and is the other half of the picture, covering sync timing rather than query cost.
