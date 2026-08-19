# Attn — Product & Technical Spec (v0.15)

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

- Gmail accounts (Google OAuth, Gmail API)
- Full-width conversation list + full-window conversation view, threaded conversations
- System mailbox views: Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash
- Keyboard triage: mark done, snooze ("remind me later"), trash, star, unread, spam, label
- Auto-advance after triage; universal undo (`Z`)
- Command palette (`Mod+K`) exposing every command
- Split inbox: Important / Other + user-defined splits by rule
- Compose, reply, reply-all, forward; contact autocomplete; drafts; attachments
- Undo send (delayed send window)
- Snippets (reusable text templates)
- Follow-up reminders ("remind me if no reply")
- AI reply drafting — opt-in, bring-your-own API key (F17)
- Instant local full-text search with operators
- Native notifications + dock/taskbar unread badge
- Background mode: launch at login, tray/menu-bar presence (F16)
- Inbox-zero state, light/dark themes
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
| AI beyond reply drafting (summaries, auto-triage, semantic search) | v2+; v1 ships only opt-in reply drafting (F17) |
| Team features (shared threads, comments) | Requires backend + multi-tenant model |
| Unified inbox across accounts | Multi-account itself is v1.1 (see D4) |
| Full keyboard remapping UI | Post-v1; v1 ships fixed defaults |
| Custom themes (user-defined palettes / accent colors) | Post-v1 (v1.1 candidate); v1 ships Dispatch dark + the derived light variant (F14). D6's semantic token system is the enabler — a custom theme is just another token set |

---

## 3. Key decisions

**D1 — Gmail only in v1.** Gmail's API gives us native threading, labels, incremental history sync, and drafts. The sync engine is written against a `MailProvider` interface so Outlook (Microsoft Graph) can be added in v2 without touching the UI or local store.

**D2 — No backend server in v1 (deliberate).** The app talks only to Google — plus, strictly opt-in, a user-chosen LLM provider for AI drafting (F17). This is a conscious trade, made for three reasons: (1) **token custody** — a server would have to hold Gmail OAuth refresh tokens, the most sensitive credential a mail app touches, turning a client into infrastructure that must be secured, operated, and trusted; (2) **operational burden** — an always-on scheduler means uptime, monitoring, and deploys for what starts as a personal tool; (3) **v1 velocity** — every piece of surface area cut is time returned to the core triage loop.

Design consequences:
- **Read statuses are out** (they need a hosted pixel endpoint).
- **Send later is out of v1** — exact-time delivery while the computer may be asleep or off is impossible client-side, and a "sends late on next launch" version isn't worth shipping. See F7 for the v1.5 plan.
- **Snooze and follow-up reminders run on local schedules with catch-up semantics.** If the app isn't running when a timer fires, it fires on next launch. These degrade gracefully — a reminder is only actionable at the computer anyway. To make "app not running" rare, the app **launches at login and keeps running in the tray/menu bar** when the window is closed (default on, see F16).
- **New mail arrives by polling** (Gmail push notifications require a public Pub/Sub webhook). Poll interval: 15s foregrounded, 60s in background — worst-case notification latency ~30s foregrounded.

Serverless roadmap: **v1** pure client → **v1.5** optional *companion Apps Script* in the user's own Google account (restores send later, adds exact-time snooze return visible from all devices — see F7) → **v2** small hosted backend (adds read statuses, true multi-device state).

**D3 — Electron + TypeScript + React (confirmed over Tauri, §9).** Two reasons beyond ecosystem maturity: (1) **one rendering engine** — Electron ships one pinned Chromium on both OSes; Tauri uses the OS webview (WKWebView on macOS, WebView2 on Windows), meaning two engines to test, with the differences concentrated on this app's two most quirk-sensitive surfaces: the contenteditable composer and arbitrary HTML-email rendering. (2) **one language** — the sync engine stays in TypeScript beside the UI, instead of moving to Rust or shipping a Node sidecar that gives back the footprint win. Tauri's genuine advantages (~10× smaller installer, lower baseline memory, faster cold start) don't move the budgets that define this product (§7): interaction latency and search speed come from the local-first architecture, not the shell. The UI is plain web tech, so a shell swap stays possible if footprint ever becomes the real complaint.

**D4 — Single account throughout v1; multi-account lands in v1.1 (§9).** The data model is multi-account from day one (every row is keyed by account), but the UI assumes one account until the core loop is excellent.

**D5 — SQLite + FTS5 as the local store.** Message headers for the account's whole lifetime (staged: interactive windows first, then a low-priority background sweep — §9 #17), full bodies for the last 90 days of Inbox mail, older bodies fetched on demand and cached permanently. Attachment bytes are never bulk-synced: metadata rides with full-format fetches, content downloads on demand. Search runs entirely locally against FTS5.

**D6 — Visual direction: "Dispatch" (settled 2026-08-09; mockups in `design/explorations/b2-*.html`).** Cool deep graphite surfaces, one amber signal color, a single sans family with tabular numerals doing the instrument work, and the lowercase `attn:` wordmark with an accent colon. Signature element: the **queue readout** ("● ● ● ○ ○ · 3 to zero") persistent in the top bar. Layout (revised 2026-08-12 after M1 dogfood, 2026-08-14 for the new-message composer, and 2026-08-15 for thread drafting, §9 #7/#9/#11/#13): full-width list ⇄ **full-window conversation or new-message composer** — the active task owns the window; `Esc` or the visible Back/List control restores the prior view at the same selection and scroll position. Reply, reply-all, and forward are the deliberate exception: their composer is the final inline card beneath the conversation so the source mail remains visible while writing. Adjacent cached conversations preload in the background so `J`/`K` changes the reader instantly without showing competing panes. This supersedes the centered overlay, the interim reading split, and the docked new-message composer; simultaneous list/reader variants are rejected. Inbox splits render as a horizontal strip (hot splits carry counts; overflow behind `···`; full jump-list in the palette). Settings live behind the account-chip menu (Settings, keyboard shortcuts, split rules, sign out) — no hamburger. Light theme derives from the same tokens at M3 (F14).

**Modifier convention:** `Mod` = `Cmd` on macOS, `Ctrl` on Windows. All shortcuts in this spec are written platform-neutrally.

> **On fidelity:** keyboard bindings, layouts, and behavioral details in this spec are *our* defaults — Gmail-compatible where sensible, inspired by Superhuman's philosophy, but not claimed to be an exact replica of Superhuman's bindings or UI.

---

## 4. Feature specifications

### F1 — Onboarding & auth

Sign in with Google via OAuth 2.0 **authorization-code + PKCE, loopback redirect** (opens system browser, redirects to `http://127.0.0.1:<port>`). Requested scopes: `gmail.modify` (covers read, label changes, and send) plus basic profile/email.

Tokens are stored via Electron `safeStorage` (macOS Keychain / Windows DPAPI). No credentials ever touch disk in plaintext.

**Signed-out state (added v0.13, PR #27):** a signed-out launch shows a dedicated sign-in screen, not a preview of someone else's mail — the earlier mock inbox is gone. The mail tree does not mount behind that screen, so no mail keybinding, IPC subscription, or command registration is live while onboarding; the sign-in action is autofocused so `Enter` reaches it directly. When `oauth.config.json` is missing the screen explains the one-time setup and links to it rather than offering a dead button, and a failed auth-status probe offers a retry instead of hanging on a checking state.

⚠️ **Real-world constraint:** `gmail.modify` is a restricted scope. **Decision for v1: dev-mode distribution** — each user supplies their own Google Cloud OAuth client (unverified-app warning is expected). Google's app verification + security assessment is deferred until/unless there is a public release (§9).

**Acceptance criteria**
- Fresh install → signed in and reading first conversations in under 60s on a typical inbox (metadata streams in; UI is usable before backfill completes).
- Revoking access from Google account settings degrades gracefully to a re-auth prompt, never a crash or silent hang.
- A signed-out launch is fully operable from the keyboard alone, and no mail shortcut does anything there.

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

*Shipped staging:* the full bounded pipeline runs as specified — inbox → bodies → drafts → all-mail →
spam → trash → per-label reconcile (the retired `sent` stage is subsumed by all-mail; old `sent` cursors
route to it) — then T13A's independent, low-priority lifetime sweep starts. Spam/Trash reconciliation
verifies each locally-labeled thread missing from the server listing by direct fetch and deletes only on
404, never on listing absence. Still M3: per-message label storage, the utility-process move, the
existence-sweep tombstone pass for label-less orphans, and the mailbox/search surfaces (§9 #10, #17).

**Window rationale and completion semantics:** headers are cheap — roughly 1–2 KB and ~10 quota units per
thread, so a typical account's lifetime header index costs an hour or two of background sweeping and a few
hundred MB, and it is what makes local search recall, complete system mailboxes, and lifetime contact
autocomplete trustworthy. Bodies and attachments are orders of magnitude heavier, so only the last 90 days
of Inbox bodies are fetched eagerly; everything older hydrates on open. Stage boundaries exist only where
behavior changes, never just to slice dates: the inbox stage guarantees the triage surface first, stages
2–6 run at normal background priority, and the lifetime sweep drops to a throttled low-priority posture.
These are eventual windows, not item caps — an API page size such as 500 must never be presented or
implemented as “only sync 500 messages.” A count cap may bound the first interactive bootstrap only when
the remaining window continues in the background or is available on demand.

**Lifetime header sweep (T13A as revised by §9 #17; supersedes the Sent-only pass of §9 #15):** after
interactive readiness, a resumable low-priority pass walks lifetime message headers across the whole account
(no label filter, newest first), skipping threads already stored. It persists its own cursor, reports
thread progress against the unfiltered listing's `resultSizeEstimate` (and exact exhausted count), reports
message context from `getProfile().messagesTotal`, and never downloads old bodies or attachments. Contact
statistics derive from the same header stream — recipients of Sent mail, senders of
received mail — so an address last emailed years ago autocompletes locally; messages labeled SPAM or TRASH
never contribute to contacts. While the pass runs, sync status reads **Live · indexing older mail** with
progress and quota-wait detail. Importing a user's saved Google Contacts through the People API remains a
separate opt-in product decision because it adds OAuth scope and consent requirements; autocomplete must not
imply that the mail-derived index contains an address book the user has never emailed.

Backfill has two distinct completion points:

1. **Interactive-ready:** the first recent page is committed and the user can read and triage local mail.
   The fresh-install target remains under 60 seconds on a typical inbox.
2. **Background index complete:** every bounded stage is exhausted and the lifetime sweep's cursor reads
   done. Its duration is proportional
   to mailbox size, Gmail's per-method quota costs, and rate-limit waits; it has no fixed five-minute SLA and
   must never make an already-usable inbox look unavailable.

After interactive readiness, the footer reports **Live · indexing older mail** rather than a blocking
“Syncing” state. It exposes stage, processed count, estimated total/ETA when Gmail supplies one, and an
explicit quota-wait state instead of appearing stuck during backoff. The top-bar “N to zero” value is the
total unread Inbox count, not sync progress, and may exceed the current rendered-list window.

**Incremental:** poll `history.list` from the last stored `historyId` (15s foreground / 60s background). Each cycle also refreshes the label catalog (`labels.list`, 1 unit): history reports label *applications*, never label create/rename/delete, so the catalog would otherwise go stale (T21). On `historyId` expiry (HTTP 404), fall back to a delta re-list; once non-Inbox mail is cached (M3), that recovery must also reconcile every cached system label and tombstone threads purged server-side while the app was away — Spam/Trash auto-purge otherwise leaves ghost rows. All writes funnel through a single reducer so server-originated and locally-originated changes apply identically.

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
- Losing the network mid-session flips the status to Offline while reads and triage keep working; restoring it returns to Live and drains the queue with no user action.

### F3 — Inbox list & conversation view

**Full-width list ⇄ full-window conversation** (D6 as revised 2026-08-12, §9 #11): the list owns the window while deciding. Opening a conversation replaces the list with one dedicated reading surface, avoiding a competing queue and eliminating pane-focus state. Closing restores the list at the same selection and scroll position.

**System mailbox navigation (M3, §9 #10):** the list/reading shell is shared by Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, and Trash. These are mailbox filters, not split-inbox lanes: Important/Other and user-defined splits appear only inside Inbox. To preserve D6's minimal chrome, v1 does not add a permanent folder sidebar; every mailbox is reachable from the command palette (`Go to …`) and a `G` chord, and the active mailbox name appears in the list header.

- Inbox = `INBOX`; Sent = `SENT`; Drafts = `DRAFT`; Starred = `STARRED`; Spam = `SPAM`; Trash = `TRASH`; Snoozed is the local reminders view from F4. All Mail contains locally cached mail without `SPAM` or `TRASH`, including archived conversations.
- Mailbox queries run entirely against the local store. M3 expands metadata sync beyond the current Inbox window so the last 12 months of system-label membership are cached; switching a cached mailbox never waits on Gmail. Older content follows F2's on-demand policy.
- Switching mailboxes closes any open conversation and restores that mailbox's prior selection and scroll when revisited. Opening a conversation otherwise uses the same full-window behavior in every message mailbox. A Draft row opens its crash-safe M2 composer draft rather than a read-only conversation.
- Triage actions immediately remove a row when it no longer matches the active mailbox. Spam and Trash are browsable but v1 still provides no permanent-delete or empty-folder action.
- Drafts merges locally composing outbox rows with cached Gmail Drafts. A local draft is discoverable offline before its first successful Gmail mirror, and multiple simultaneous drafts remain distinct. M3 owns the unified Drafts mailbox behavior.
- Outbox is an on-demand local operational view, not a permanent sidebar item. T16 makes the top-bar pending readout and **Go to Outbox** command open queued, sending, failed, and needs-review items; actionable rows reopen in the composer without discarding local content.

- The full-width list groups conversations under relative date headings (Today, Yesterday, Last 7 days, then older periods) and shows sender(s), subject, a 1–2 line snippet, timestamp, and chips (attachment, starred, snoozed-return, follow-up). Unread rows are visually distinct. Virtualization remains required before the M2 daily-drivable sign-off if performance data shows the current mounted list cannot meet the 10k-thread budget.
- In the list, `J`/`K` and unmodified `ArrowUp`/`ArrowDown` move the selection.
- `Enter` or clicking a row opens the **full-window conversation** at a responsive readable measure (720–1120px), positioned at its newest message or restored thread-bound draft. Its header contains a visible Back/List control, subject, quiet queue position ("4 of 12"), and `Esc` hint. The newest message is expanded; older messages start as one-line summaries and their bodies (including HTML frames) are not mounted until expanded. Clicking an expanded message's header collapses it into that same summary row; clicking the summary reopens it.
- While reading, `J`/`K` opens the next/previous conversation at its newest message or restored draft; at the first conversation, `K` returns to the full-width list instead of remaining in the reader. The adjacent conversations are fetched into the local renderer cache beforehand so this usually has no loading state. Unmodified `ArrowUp`/`ArrowDown`, `Space`/`Shift+Space`, and `PageUp`/`PageDown` scroll the current conversation, while `Shift+ArrowUp`/`Shift+ArrowDown` extend the selection exactly as `Shift+J`/`Shift+K` do — the arrow aliases behave the same in the list and the reader. Modifier+key chords retain their platform/browser meaning. Keyboard handling continues after clicking recipient, attachment, or trim controls and while focus is inside an HTML-mail frame; `Enter` on a focused mail link retains its native link action. Unless a transient overlay consumes it first, `Esc` or Back/List returns to the full-width list from every Tab stop—including focused buttons and mail links—with selection and scroll intact.
- **Message display:** each message card shows the sender, a recipient summary ("to me, Priya · cc Daniel") that expands on click to the full From/To/Cc/Bcc/Reply-To set with the full date, the body, and attachment chips (filename + size — click downloads to the OS Downloads folder and reveals the file). Quoted trails and signatures auto-collapse behind a plain-text `...` control rendered inline at the trim boundary; the control stays in place while expanding/collapsing and a second click collapses again. `Tab` always retains native focus navigation across the product. For collapsed HTML mail, the `...` control precedes links inside the mail frame in keyboard order; reaching it reveals the hidden trail without changing the reading viewport dimensions, and the next Tab continues into the mail links. Revealing a long trail makes the existing reading surface scroll instead of growing the window. Text-like HTML and fallback text use Attn's native reading surface; presentation HTML with tables, media, styles, or layout attributes keeps a light document canvas shared by its body, trim control, and attachments. Decorative markup confined to a signature or quoted trail does not make an otherwise plain message a presentation document — but a quoted trail that is itself a presentation document is content, not decoration, and keeps the light canvas. A forward carries the whole original message inside its quote, so ignoring it would render a newsletter on the dark surface with its canvas stripped. Wide mail gets an in-frame horizontal scrollbar, and the conversation reserves its vertical scrollbar gutter so expanding content does not shift the reader. Bcc appears only on the user's own sent copies — Gmail never exposes other senders' Bcc.
- Bodies for the selected and adjacent conversations are preloaded so opening never shows a spinner.
- **Auto-advance:** after done/snooze/trash, selection (and the open reader) moves to the next conversation automatically (setting: next / previous / back to list).

**Acceptance criteria**
- 60fps scroll on a 10,000-thread list.
- Opening a cached conversation renders in < 50ms; `Esc` returns instantly with scroll + selection intact.
- Auto-advance never lands on a stale (just-triaged) row.
- Every message's full recipient set is inspectable in two interactions or fewer; attachments download to the OS Downloads folder and are revealed on completion.
- Quote/signature collapsing never reduces an all-quote/all-signature message to a blank card, never hides content without a visible expander, and expanding/collapsing is instant (no network) without moving the control or remounting the HTML document.
- Opening by keyboard or pointer transfers reading keys to the conversation. `J`/`K` changes conversation, reading keys scroll, inline controls and HTML-frame focus never strand the keyboard loop, and expanding long content does not horizontally shift the reading surface.
- Every system mailbox is reachable by palette and keyboard; a cached switch renders in < 50ms, returning restores selection/scroll, and the displayed rows match the system-label rules above without a network round trip.

### F4 — Triage actions & undo

| Action | Behavior |
|---|---|
| **Mark done** (`E`) | Removes from inbox (Gmail archive). The signature triage verb. |
| **Snooze / Remind later** (`H`) | Leaves the inbox now, returns at a chosen time. Picker offers presets (Later today, Tonight, Tomorrow, This weekend, Next week) + natural-language input ("thu 2pm", "in 3 days"). v1 implementation: remove `INBOX` and store the due-time in the local reminders table; at due time (or next launch) restore to inbox with a "returned" chip. Gmail web therefore sees a normal archive until return. **A new reply wakes the thread immediately** (configurable). Cross-device labeling and exact-time restoration move to the v1.5 companion script (F7). |
| **Trash** (`#`) | Moves to Gmail trash. No permanent delete anywhere in v1. |
| **Star** (`S`) | Toggles star. |
| **Unread** (`U`) | Toggles read state. |
| **Spam** (`!`) | Reports spam. |
| **Label** (`L`) | Opens label picker (search-as-you-type, add/remove). |
| **Select** (`X`) | Toggles selection; `Shift+click`/`Shift+J/K`/`Shift+↑/↓` extends. All triage verbs operate on the selection when one exists. |
| **Undo** (`Z`) | Reverses the last action — including bulk actions — from a session-scoped stack (last 50 actions). Every destructive-feeling verb is instantly reversible; this is what makes fearless triage possible. |

Bare-letter shortcuts do not also accept their shifted variants: `Shift+letter` is reserved for explicit
combinations such as `Shift+J/K`. Printable symbols that require Shift, including `#` and `!`, are unaffected.

**Acceptance criteria**
- Any triage action gives visual feedback in < 16ms (optimistic), including on selections of 100+ conversations.
- `Z` fully reverses a bulk archive of 100 conversations, locally and (after sync) server-side.
- A snoozed thread returns within 60s of its due time while the app runs, or immediately on next launch if it was closed; a reply during snooze surfaces it immediately.
- Snoozed threads are findable in the local "Snoozed" view (`G` then `H`) while the Attn profile exists. Reinstall durability and cross-device visibility are not v1 promises (decision #6).

### F5 — Command palette

`Mod+K` opens the palette from anywhere. It is the app's primary control surface:

- Fuzzy-matches every registered command: triage verbs with arguments ("Remind me tomorrow 9am"), navigation ("Go to Sent"), settings ("Switch theme"), snippets ("Snippet: intro").
- Parameterized commands accept inline arguments with natural-language parsing where applicable (snooze and reminder times).
- Each result shows its keyboard shortcut — the palette is also how users learn the keys.
- Ranking: exact prefix > fuzzy score, with recently/frequently used commands boosted.
- **Engineering rule:** every user-facing feature must register a palette command. No feature ships reachable only by mouse.

The shortcut footer becomes a context-aware guide in a separate M3 task. Its default state is a single,
non-wrapping line of only the commands relevant to the active view. Pressing a chord prefix such as `G`
temporarily replaces that line with the valid next keys derived from the same command registry: fixed
mailboxes use `I/A/T/D/S/H/P/R`, while `1`–`9` maps to Inbox splits in configured order. The guide remains
visible until completion, `Esc`, a view change, or a short 2–3 second timeout. The command palette (`Mod+K`)
and cheat sheet (`Mod+/`) remain the exhaustive discovery surfaces; T14 does not implement this footer.

**Acceptance criteria**
- Opens in < 50ms; results re-rank per keystroke in < 30ms.
- Every spec'd feature in this document is invocable from the palette.

### F6 — Compose, send & undo send

`C` opens new mail in a **full-window focused surface** with a centered 800–900px writing measure. The prior
list or conversation remains mounted but hidden so its selection and scroll are restored exactly when `Esc`
or the visible Back control saves and closes the draft. From a mail list, `R` or `F` opens the selected
conversation directly into its inline reply or forward composer. In the reader, `R`/`A`/`Enter`/`F` append
an inline reply, reply-all, or forward composer beneath the existing messages. Quoted history sits behind a compact inline
`...` control. Text-like source mail inherits the composer surface instead of introducing a separate panel,
normalizing sender-supplied dark foreground colours for contrast, while presentation HTML retains the same
light document canvas and safe HTML structure used by the reader.
Opening a conversation with an existing thread-bound draft reopens its newest draft inline. The inline
composer's close button saves the draft and leaves the reader open; `Esc` or the conversation Back control
saves it and returns directly to the originating list in one action. Thread-bound drafts opened from Drafts
return to this same inline context whenever the parent conversation is locally available. While composing, the global mail shortcut
footer is absent and the composer owns its action footer, so editing controls can never overlap global hints.

- **From identity:** the active signed-in account is always shown in a read-only From field. Sender aliases
  and account switching are not implied or supported in v1.
- **Recipient autocomplete** ranked by interaction frequency + recency, built locally from synced sent mail. First suggestion accepted with `Tab`/`Enter`.
- **Rich text (widened 2026-08-15, §9 #16):** bold/italic/underline/strikethrough, bulleted & numbered lists, links, blockquote, **inline images, tables, font family and size, text and background colour, and alignment** — Gmail's own authoring surface. Pasting an image into the body is supported and travels as a `cid:` inline part. Heading levels are deliberately out: Gmail's composer has none, so they would be a superset rather than parity.
- **Zero formatting loss is an invariant, not an aspiration.** Content Attn's editor cannot represent is preserved byte-for-byte rather than dropped: it renders in place, is not editable inline, and round-trips unchanged through save, Gmail Drafts sync, and send. No draft ever loses formatting by being opened in Attn.
- **Attachments:** drag-and-drop or picker, up to Gmail's 25MB limit, with progress indication. Attached files are copied into a local spool immediately, so a draft is self-contained even if the original file moves or the app force-quits, and that spool remains the source of the bytes for the rest of the draft's life.
- **Drafts:** autosaved to the local store one second after typing stops, and at least every five seconds while typing continues, so a force-quit loses at most five seconds of work. The **Gmail Drafts mirror is a separate, slower schedule** — debounced three seconds after typing stops, skipped entirely when nothing changed since the last push — so a composing session produces a handful of `drafts.update` calls rather than one per second. Drafts are listed in the Drafts view (`G` `D`) and reopenable, and thread-bound drafts are marked on their conversation row. A reply or forward the user never contributed to is **discarded on close, not saved**, matching Gmail: its quote, planned recipients and `Re:`/`Fwd:` subject are Attn's own work, so an untouched one leaves no draft row, no conversation mark, and nothing to mirror. Anything the plan does not write — a body, an attached file, a `Bcc`, a recipient on a forward — makes it the user's and keeps it. Attn's reply/reply-all entry points share one local reply slot and its forward entry point shares one local forward slot per conversation; separately identified Gmail drafts remain distinct even when several belong to the same conversation.
- **Draft sync is two-way (2026-08-15):** drafts written or edited in Gmail appear and open in Attn, and Attn's edits flow back. Conflicts resolve last-write-wins, except that a draft open in the composer always wins over a remote change.
- **A round trip keeps the body and the quoted trail apart (2026-08-16):** Gmail stores a draft as one document, so a reply or forward returns with its quote joined to the body. Attn separates them again on reimport by recognizing the trailing quote structurally — never by matching bytes, since Gmail rewrites markup. Reopening therefore shows the same collapsed quote it showed before the round trip, rather than loading quoted mail into the editor as authored content. Attn declines to split when anything but whitespace follows the quote, because the author typed it there and reassembly always puts the quote last; such a draft stays merged.
- **A mirrored draft is complete (2026-08-16):** attachments mirror with the body, so a draft composed in Attn can be opened and **sent from Gmail web or mobile** with its files intact. Because Gmail replaces a draft wholesale, each checkpoint re-sends every attachment byte; the mirror interval therefore lengthens once a draft carries meaningful payload, while attaching or removing a file still pushes on the normal interval. Bytes stream from the local spool rather than being held in memory, and a file that Gmail echoes back is recognized as the one already held locally rather than stored a second time.
- **Send:** `Mod+Enter`.
- **Undo send:** sending holds the message in a local outbox for a configurable delay (0/5/**8**/10/20/30s, default 8). A toast shows "Sent — Undo (Z)", stays visible for the entire window, and counts down the durable send deadline with a progress bar. Undo reopens the composer with everything intact. The API call happens only after the window elapses.
- Outbox state machine (`composing → queued → sending → sent`) guarantees exactly-once send across crashes: on relaunch, `sending`-state items are verified against the server before any retry.

**Acceptance criteria**
- Composer opens in < 50ms; typing latency is imperceptible (< 16ms/keystroke).
- Force-quit mid-compose → draft fully recovers on relaunch.
- Undo within the window always succeeds; the message never reaches the network before the window closes.
- No scenario produces a duplicate send.

### F7 — Send later (deferred to v1.5)

**Cut from v1** by product decision: a scheduled send must go out at the scheduled time, computer on or off — "sends late on next launch" silently fails the promise made to the recipient, and a feature that can't keep its promise is worse than its absence. The Gmail API does not expose Gmail's native Schedule Send, so exact-time delivery requires something running while the desktop is off (D2).

**v1.5 plan — companion Apps Script (no server we operate):** a small script installed once into the user's own Google account, running on Google's infrastructure as the user. The desktop app writes a normal Gmail draft plus a schedule label (e.g. `[Attn]/SendAt/2026-08-12-0900`); the script sweeps upcoming sends on a time-driven trigger, self-schedules a one-shot trigger per send, and calls `drafts.send` when due. Delivery lands within a few minutes of the target time, and OAuth tokens never leave Google's side. The same script also restores snoozed threads at their exact due time, making snooze returns visible from any device (closing the cross-device gap noted in F4/D2). Reserved keybindings: `Mod+Shift+Enter` (composer), `G` then `L` (Scheduled view).

### F8 — Snippets

Named, reusable text blocks inserted into the composer via palette ("Snippet: …") or a `;shortcut` text trigger typed inline. A snippet may define body text (with an optional `{cursor}` placement marker) and optionally a subject. Managed in Settings.

**Acceptance criteria**
- Insertion < 50ms; `{cursor}` lands the caret correctly; `;trigger` expansion is undoable with one `Mod+Z`.

### F9 — Follow-up reminders

When sending, optionally set "remind me if no reply" (composer control or palette: 3 days / 1 week / custom). If no reply arrives by the deadline, the thread resurfaces at the top of the inbox with a **Follow up** chip. Any reply cancels the reminder. Pending follow-ups are listed in the Snoozed/Reminders view.

**Acceptance criteria**
- Reply from any participant cancels the reminder within one poll interval.
- Resurfaced threads are visually distinct and sort above normal mail.

### F10 — Instant search

`/` focuses search. Queries run **entirely locally** against SQLite FTS5 (from, to, subject, body, attachment filenames) with results as you type.

- Operators: `from:`, `to:`, `subject:`, `in:` (label/view), `is:unread|starred|snoozed`, `has:attachment`, `before:`/`after:`.
- Result rows open straight into the conversation; `Esc` returns to the result list, then to the inbox.
- Local coverage follows the store: header fields match lifetime mail once the sweep completes; body terms, `has:attachment`, and filenames match only hydrated mail. A "Search all of Gmail" row runs the same query server-side (Gmail `q=`) and merges results; threads it fetches persist through the normal write path and stay cached.

**Acceptance criteria**
- p95 < 100ms for local queries on a 50,000-message store.
- Operators combine (e.g. `from:acme.com has:attachment after:2026-01-01`).

### F11 — Split inbox

The inbox is divided into **splits** — tabs above the list, each an independently triaged queue:

- Defaults: **Important** (Gmail's importance/category signals) and **Other**.
- User-defined splits match rules on: sender address, sender domain, mailing-list (`List-Id`), or label. First matching split wins (user orders them); every thread appears in exactly one split. Splits are views — mail is never moved by splitting.
- Navigate: `←`/`→` between splits; `G` then `1`–`9` jumps by configured split order. Each split
  keeps its own selection and unread count, and the context-aware shortcut footer shows the valid digit
  completions while the `G` chord is active.
- **Strip scaling (D6):** splits render as a horizontal top-bar strip — hot splits show unread counts, cold ones stay quiet, and past ~8 the strip scrolls with overflow behind `···`. The full jump-list lives in the palette ("Go to: <split>"). Chrome stays proportional to hot lanes, not total lanes.
- Per-split notification settings (see F12): by default only Important notifies.

**Acceptance criteria**
- Split switch < 50ms with selection preserved per split.
- Rule changes re-bucket the inbox in < 1s for 10k threads, with no thread appearing in two splits.

### F12 — Notifications & badging

- Native OS notifications (macOS Notification Center / Windows toast) for new mail in notification-enabled splits: sender + subject + snippet; click opens the thread.
- **Batching:** a poll cycle delivering more than 3 new conversations collapses into one summary notification ("7 new conversations") instead of a burst of toasts. A summary names no single thread, so clicking it raises the window on the inbox rather than opening a conversation — only per-message notifications carry a thread target. Notifications are suppressed entirely while a window is focused.
- Unread badge: macOS dock badge; Windows taskbar overlay. Counts only notification-enabled splits (i.e., the number that matters, not all mail).
- Notification latency is bounded by polling: ≤ ~30s foregrounded (D2).
- **M1 staging:** before splits exist, notifications and the badge cover every unread Inbox conversation. Windows uses a static-dot overlay with the numeric count in its tooltip. Per-split filtering arrives with F11 in M3; a rendered Windows numeric overlay is M4 packaging polish.

### F13 — Inbox zero

When a split reaches zero, the list pane is replaced by a full-pane zero state: a rotating background image, a short affirmation, the time, and a hint of remaining splits with counts ("Other: 12"). Reaching zero should feel like a reward.

### F14 — Themes

Light and dark themes; follows the OS by default with a manual override (palette: "Switch theme"). Dark is the Dispatch base (D6); the light variant is derived from the same tokens at M3, and user-customizable themes (own token sets over the same semantic names) are post-v1 roadmap. All UI, including rendered HTML mail, must be legible in both (dark mode sanitizes/inverts mail backgrounds where safe, with a per-message "view original" escape hatch).

### F15 — Settings

Minimal surface, all reachable via palette: account (sign out), undo-send delay, auto-advance direction, per-split notifications, snippet manager, split-rule manager, theme, background behavior (launch at login, tray/menu-bar — see F16), AI drafting (enable, provider & key, voice profile — see F17), and a keyboard cheat-sheet (`Mod+/`).

**Entry point (D6):** the account chip in the top bar is the menu — Settings (`Mod+,`), Keyboard shortcuts (`Mod+/`), Split rules, Sign out. No hamburger icon; every item is also a palette command.

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

### F17 — AI reply drafting (opt-in, bring-your-own key)

**Off by default.** Enabling requires the user's own API key — an Anthropic key or any OpenAI-compatible endpoint (which also covers fully local models via Ollama / LM Studio for a zero-cloud setup). Keys live in `safeStorage`; requests go **directly from the client to the chosen provider**, no intermediary (consistent with D2). Provider-agnostic; model user-selectable with a sensible default per provider.

Capabilities:
- **Draft reply** (palette command; dedicated shortcut assigned during M4): generates a reply to the open thread, streamed into the composer as a fully editable draft.
- **Voice profile:** tone preset (concise / friendly / formal) plus free-text standing rules ("sign off with 'Best, Chao'", "never use exclamation marks").
- **Voice matching:** a handful of the user's recent sent replies, selected locally, accompany the request as style examples (toggleable).
- **Inline refine:** after a draft lands, a one-line instruction ("shorter", "more formal") regenerates it.

Guardrails:
- **Never auto-sends.** Output is always an editable draft behind the normal send flow, undo send included.
- Runs **only on explicit invocation** — no background AI processing of the mailbox, ever.
- The enable screen states plainly what leaves the machine and when: the current thread, the voice profile, and any selected style examples, sent to the chosen provider only when a draft is requested.
- Disabling stops all LLM traffic; removing the key deletes it from the OS keychain.

**Acceptance criteria**
- Feature disabled → zero network traffic to any LLM endpoint.
- UI never blocks during generation; `Esc` cancels cleanly.
- With voice matching off, no sent-mail content is ever included in requests.
- Draft insertion is undoable like any other edit.

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

**List & navigation**

| Keys | Action |
|---|---|
| `J` / `K` | Next / previous conversation in the list or reader |
| `↓` / `↑` | Next / previous conversation in the list; scroll while reading |
| `Enter` | Open conversation |
| `←` / `→` | Previous / next Inbox split (M3) |
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
| `G` then `1`–`9` | Go directly to an Inbox split by configured order (M3) |

**Triage** (list or conversation)

| Keys | Action |
|---|---|
| `E` | Mark done (archive) |
| `H` | Snooze / remind me later |
| `#` | Trash |
| `S` | Star |
| `U` | Toggle unread |
| `!` | Spam |
| `L` | Label picker |

**Conversation**

| Keys | Action |
|---|---|
| `R` / `A` or `Enter` / `F` | Reply / reply-all / forward |
| `N` / `P` | Next / previous message in thread |
| `O` | Expand / collapse message |
| `Tab` | Move focus normally; reveal a hidden trail when focus reaches its `...` control |

**Composer**

| Keys | Action |
|---|---|
| `Mod+Enter` | Send |
| `Mod+B` / `Mod+I` / `Mod+U` | Bold / italic / underline |
| `Mod+Shift+K` | Insert link (`Mod+K` stays reserved for the palette everywhere) |
| `Mod+;` | Insert snippet |
| `Esc` | Close (draft saved) |

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
- **M1/M2 host the sync engine in the Electron main process** behind Electron-free store/provider
  interfaces. M3 begins by moving Gmail fetch, backfill, derived-data rebuilds, and FTS indexing into an
  Electron utility process. The main process remains the typed IPC/lifecycle broker; the utility process
  owns background service work and resumes from durable checkpoints after a crash. Interactive actions and
  outbox work have priority over historical indexing, and moving the boundary must preserve the one-reducer
  and exactly-once invariants.
- **One reducer, two sources:** server history events and local optimistic actions flow through the same state-transition code, which is what keeps optimistic UI and sync convergent.
- **Scheduler** owns every timer (snooze due-times, follow-up deadlines, undo-send windows); on launch it executes anything that came due while the app was closed (catch-up, D2).

**Local schema (core tables):** `accounts`, `threads`, `messages` (bodies, recipients, attachment metadata), `bodies` (FTS5 external-content), `labels`, `thread_labels`, `contacts` (with frequency/recency stats), `splits`, `snippets`, `reminders` (snooze + follow-up), `outbox`, `action_queue`, `sync_state`, `settings`. Every row keyed by `account_id` (D4).

**Security & privacy:** OAuth tokens and LLM API keys via `safeStorage` (Keychain/DPAPI); DB under the OS user profile; TLS to Google only — plus the opt-in LLM provider (F17), which receives content solely on explicit invocation; **no telemetry, no other third-party services** in v1. Remote images in HTML mail load directly (no proxy without a server, D2), with a global "block remote images" toggle and per-sender overrides — default is load (decision log, §9).

**HTML mail rendering:** sanitized (DOMPurify-class allowlist), rendered in a sandboxed `<iframe>`/webview with no script execution, links open in the system browser. Some legitimate senders serve images with `Cross-Origin-Resource-Policy: same-origin`, which Chromium would block inside that frame; the app removes only that response header, only for image requests originating from the mail frame — no other request or header is modified. The frame is measured after load and on resize, preserves horizontal overflow inside the frame, and remains mounted when quote/signature visibility changes. A shared surface classifier gives text-like or fallback content the native Attn canvas and gives presentation HTML a light document canvas; the composer quote preview uses the same decision. Filename-bearing MIME parts count as attachments whether Gmail supplies an attachment ID or inline base64url data. The stored `inlineData` field is withheld from `ConversationMsg`, and inline-delivered attachments can download without a network request. For `cid:` rendering, however, `mail:getInlineImage` deliberately sends matching image content through the typed preload bridge as an allowlisted-MIME base64 `dataUrl`, capped at 10 MB; the renderer assigns that value to the image in the scriptless mail iframe. Unresolved references remain inert broken-image placeholders.

**Packaging:** `electron-builder`; auto-update via GitHub Releases. macOS notarization + Windows code signing required for public distribution (skippable for personal builds). *Status:* personal-build packaging shipped early, at M1 exit — a manually dispatched GitHub Actions workflow produces macOS DMG/ZIP for both architectures (ad-hoc signed) and a Windows NSIS installer (unsigned), each verified by `npm run package:verify`. Auto-update and real signing/notarization remain M4.

**Testing:** unit tests on the reducer/sync engine (the correctness core — replay recorded history streams), command-registry tests (every command has a handler + palette entry), Playwright smoke e2e (sign-in stubbed, triage loop, compose/send against a mock provider).

---

## 7. Performance budgets

| Metric | Budget |
|---|---|
| Cold start → interactive inbox (warm OS cache) | < 2s |
| Open cached conversation | < 50ms |
| Triage action visual feedback | < 16ms |
| Command palette open / re-rank | < 50ms / < 30ms |
| Local search p95 (50k messages) | < 100ms |
| List scroll (10k threads) | 60fps |
| Composer keystroke latency | < 16ms |
| New-mail notification latency (app running) | ≤ 30s |
| Memory, steady state (50k messages synced) | < 500MB |

M1 ships a dedicated 2,000-thread Electron performance job with absolute CI guardrails for list render, conversation open, and triage feedback. Full percentile/10k-thread budget enforcement and regression baselining remain part of the M2 daily-drivable hardening pass.

Initial sync is measured at both completion points above: time to interactive-ready is a product budget;
time to finish background indexing is reported with mailbox size, stage request counts, effective
threads/minute, and quota-wait time. A single wall-clock target for full indexing would be misleading across
mailboxes and Gmail quota regimes. Background work must preserve every interaction budget in this table.

---

## 8. Milestones

Each milestone ends in a usable app; the daily-drivable bar is M2.

**Status (2026-08-16):** all planned M1 feature capabilities are implemented. The engineering exit audit and real-Gmail airplane-mode drain are complete; only the real-OS notification click-through smoke in docs/M1-PLAN.md remains. M2's feature work has shipped: the renderer decomposition (#31), main-process seams (#30), mail-out test scaffolding (#37), sent-mail/contact foundation (#32), full-window composer with crash-safe drafts (#38), MIME builder and reply semantics (#39), on-demand body hydration (#41), drafts as first-class objects with reply/forward entry points, rich content with the zero-loss invariant, and two-way Gmail Drafts sync (#43, #44), outbox send and undo send (#45), self-healing failed actions (#47), outgoing attachments (#48), inline thread drafting (#50), the lifetime header sweep plus the full bounded stage pipeline pulled forward from M3 (#51), and the composer dogfood fixes (#52). Still open before M2 sign-off: the T21 label-catalog refresh in the poller, the T20 hardening pass (10k-list decision, composer latency profile, weighted token-bucket limiter, backfill evidence, dogfood week, doc sweep), and the manual real-Gmail evidence items recorded in docs/M2-PLAN.md.

- **M0 — Walking skeleton.** Electron shell (both OSes), Google OAuth, metadata backfill into SQLite, read-only list + reading view, `J/K/Enter/Esc`. *Proves: auth, sync, and the 60fps list.*
- **M1 — Triage core.** First items: **apply the Dispatch direction** (D6 — graphite/amber tokens, `attn:` wordmark, layout per D6, split strip, account menu) and **sanitized HTML mail rendering** (allowlist sanitizer + sandboxed iframe per §6 — triaging means reading real mail; M0 shipped plain-text bodies only). The reading work adds recipients, attachments, quote/signature collapse, and—after M1 dogfood—the full-window conversation that supersedes the interim split. Then: done/snooze/trash/star/unread/label, selection + bulk, auto-advance, `Z` undo, durable action queue + offline replay, snooze scheduler, tray/background mode + launch at login, basic notifications. *Proves: the core loop and offline correctness.*
- **M2 — Mail out.** Composer (rich text, attachments, autocomplete), reply/all/forward, crash-safe drafts, send + undo send, exactly-once outbox. **← daily-drivable.**
- **M3 — Find & focus.** Opens with the sync restructure the utility-process move already implies (§6, §9 #17), planned as S1–S4 in docs/M3-PLAN.md. The all-mail and spam-trash backfill stages and per-label membership reconciliation (S3 and half of S4) shipped early, in M2's #51; what remains is the utility-process move (S1), per-message label storage (S2), and the existence-sweep tombstone pass for expiry recovery (S4). Then: FTS5 instant search + operators, system mailbox navigation (Inbox/All Mail/Sent/Drafts/Starred/Snoozed/Spam/Trash), split inbox + rules, inbox-zero states, themes, command palette hardened (every command registered), and the contextual chord guide (§9 #14).
- **M4 — Power finish.** Snippets, follow-up reminders, AI reply drafting (F17), settings surface, badge polish, auto-update + signing/notarization (personal-build packaging shipped early, at M1 exit — §6 Packaging).

**Post-v1 sequence:** v1.1 — global-hotkey quick panel (quick compose + quick search), multi-account (switcher `Mod+1..9`; unified inbox stays out), and custom themes (user token sets over D6's semantic names). v1.5 — companion Apps Script: send later + exact-time snooze return (F7). v2 — hosted backend: read statuses, true multi-device state.

**Success metrics (post-M2 dogfood):** p95 action latency vs. budget, % of actions invoked via keyboard (target > 80%), time-to-zero on a 50-conversation morning inbox (target < 15 min), crash-free sessions > 99.5%.

---

## 9. Decision log (1–6 resolved 2026-08-09; later entries dated inline)

1. **Multi-account:** not in v1. Moved out of the M4 stretch into v1.1, alongside the quick panel. Data model stays multi-account-ready (D4).
2. **OAuth distribution:** dev-mode for v1 — each user supplies their own Google OAuth client; Google verification deferred until/unless a public release (F1).
3. **Read statuses:** out of v1; revisit at v2 with the hosted backend (D2).
4. **Shell:** Electron confirmed over Tauri — one rendering engine and one language outweigh Tauri's footprint advantages for this app (D3).
5. **Remote images in HTML mail:** default load, with the global block toggle and per-sender overrides (§6 Security).
6. **Snooze reinstall durability (updated 2026-08-12):** accepted — v1 snooze state is local-only. A reinstall loses due-times and cannot distinguish those archived threads from ordinary archived mail. The v1.5 companion script adds Gmail-side labels and exact-time restoration; v1 does not claim cross-device visibility or reinstall recovery.
7. **Conversation layout revised (2026-08-11; superseded by #11):** v0.7's centered overlay didn't hold up for reading, so M1 first moved to an on-demand split. Decision #11 records why that intermediate layout was later removed.
8. **Push vs polling (2026-08-11):** polling stands for v1. Gmail push means `users.watch` → Cloud Pub/Sub → a public HTTPS webhook — a server, which D2 rules out. The serverless workarounds were weighed and rejected: desktop Pub/Sub *pull* needs each user's own GCP project (topic, publish grant to Gmail's push service account, daily `watch` renewal) — past the dev-mode onboarding ceiling; IMAP IDLE needs the full `https://mail.google.com/` scope (broader than `gmail.modify`) plus a second protocol stack maintained as a wake signal. Polling at 15s/60s meets F12's ≤30s latency bound at negligible quota (`history.list` = 2 units/call). Revisit with the v2 hosted backend.
9. **Reading interaction refined (2026-08-11; updated through PR #23):** real-mail dogfood replaces F3's fixed ~720px reading column and detached quote controls with a responsive 720–1120px measure and an inline, position-stable `...` boundary control. HTML-mail overflow stays inside the message frame, while a stable outer scrollbar gutter prevents reader-width jumps. PR #23 makes expanded-message collapse and keyboard continuity across Tab stops explicit. The split-specific focus behavior from this iteration is superseded by #11.
10. **System mailbox navigation is explicit v1 scope (2026-08-11):** Important/Other are Inbox splits, not substitutes for Gmail's system mailboxes. M3 adds local-first Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, and Trash filters in the existing list/reading shell. Palette commands and `G` chords replace a permanent sidebar; supporting them requires expanding cached metadata/system-label coverage beyond the M1 Inbox-only query.
11. **Full-window reading replaces the split (2026-08-12):** showing the compact queue beside the message made reading more distracting and introduced an invisible list/message focus mode. Attn returns to D5's one-clear-focus principle: opening replaces the list with a full-window reader, `J`/`K` always changes conversation, dedicated reading keys scroll, and `Esc`/Back restores the preserved list. Neighbor preloading retains preview-like speed without simultaneous panes. The split is not kept as an option in v1 because that would preserve two interaction models through composer and command-palette work.
12. **Sync status is a product surface (2026-08-13, PR #25):** local-first deliberately hides the network, which also hid real failures — a missing OAuth config or expired history checkpoint previously failed silently while the inbox quietly went stale. The footer now always shows Live/Checking/Syncing/Offline/Error (F2 "Sync visibility"), with stage-granular backfill progress and retry/copy actions on error. Offline is deliberately calm — local mail keeps working and retry is automatic; error is deliberately loud. The same PR made the backfill itself staged and resumable (metadata → bodies → reconcile with per-page cursor checkpoints).
13. **Full-window new mail plus inline thread drafting replaces the docked overlay (2026-08-14, revised 2026-08-15):** the bottom-right panel made writing feel secondary and could collide with the global shortcut footer. New mail owns the active window at a centered writing measure, preserves the hidden list/reader state, and restores it on `Esc`/Back. Reply, reply-all, and forward instead compose as the final card beneath the source conversation, matching the contextual model used by Gmail and Superhuman. Both modes own their action footer and replace the global mail footer while active.
14. **The shortcut footer becomes a contextual chord guide (2026-08-14):** default hints stay minimal and view-specific. A prefix such as `G` temporarily shows valid next keys from the command registry, including fixed mailbox letters and dynamic split digits. The palette and cheat sheet remain the complete references; implementation is an M3 follow-up, separate from composer work.
15. **Lifetime contact indexing is decoupled from mail history (2026-08-14):** the recent Sent window makes autocomplete useful quickly, then a resumable low-priority header-only pass derives recipients across lifetime Sent without cloning old bodies or creating old browsable mail rows. Importing saved Google Contacts remains a separate OAuth/product decision.
16. **The composer's narrow schema is reversed for zero-loss editing (2026-08-15):** M2's composer deliberately shipped a minimal node set (bold/italic/underline, lists, links, blockquote) so output would be predictable and pasted junk would be rejected by construction. The narrowness lived in two places we control, neither of them a Lexical limitation: the registered node list in `editorConfig.ts` and the outgoing sanitizer allowlist in `composer/sanitize.ts`. Dogfood rejected the consequence rather than the reasoning: a client that cannot paste an image, and that silently flattens a Gmail-authored draft when you open it, is not a Gmail replacement. Two changes follow. The editor widens to cover what Gmail's own composer emits — inline images, tables, font family and size, text and background colour, alignment, and strikethrough (heading levels are excluded, since Gmail has none) — and anything still outside that set is **preserved byte-for-byte as an opaque region** rather than dropped, so "no formatting loss" becomes an invariant that holds for arbitrary HTML instead of a promise that holds until someone pastes something unusual. The original rationale is retained where it still applies: outgoing content stays untrusted and is still sanitized (M2 global rule 3), the sanitizer's allowlist widens deliberately rather than becoming permissive, and preserved regions are rendered through the same scriptless path as incoming mail. Cost is accepted knowingly: this expands M2 beyond composer-and-send, and F8 snippets and F17 AI drafting must now target a richer document model.
17. **Lifetime headers replace the 12-month metadata window (2026-08-15):** v0.13's 12-month window was a scoping decision, not an architectural constraint, and it quietly broke three product promises — search recall (mail archived before install was invisible even when weeks old, because backfill was Inbox-scoped), contact autocomplete beyond a year, and complete system mailboxes. Headers are cheap (~1–2 KB and ~10 quota units per thread; a 60k-thread account sweeps in under an hour of background time inside Gmail's ~250 units/user/sec budget) while bodies and attachments are orders of magnitude heavier, so v0.15 retargets the store at **lifetime headers, windowed + on-demand bodies** (D5, F2). The backfill becomes priority-ordered stages over one idempotent walk — inbox → bodies → drafts → all-mail 12m → spam-trash → reconcile → lifetime sweep — where every stage skips already-stored threads, consecutive slices overlap rather than carving Gmail's fuzzy date-operator complements (a seam gap loses mail silently; overlap costs ~1% in listing), and a stage boundary exists only where behavior changes (priority, throttle, or what runs next). Recorded consequences: `threads.list` excludes SPAM/TRASH unless asked and Gmail purges both at ~30 days, so those stages are explicit and inherently small; SPAM/TRASH messages are excluded from contact statistics; per-message label storage becomes necessary once Trash is local, because a thread-level label union cannot express a partially-trashed thread; the poller refreshes `labels.list` each cycle because history never reports label create/rename/delete; and `historyId`-expiry recovery must reconcile every cached system label and tombstone server-purged threads, not just Inbox. Staging: T13A ships the lifetime sweep and contact derivation in M2 (superseding #15's Sent-only pass); the all-mail/spam-trash stages, per-message labels, and recovery generalization open M3 alongside the utility-process move. Deliberately still not fetched: People-API contacts (#15), send-as aliases/signatures (extra OAuth scope — a composer product decision), Gmail-native snooze (not exposed by the API), filters/vacation/forwarding settings, confidential-mode bodies (the API returns placeholders), and legacy Hangouts `CHAT` rows (skipped defensively).
18. **Post-M2-review product calls (2026-08-17):** (a) **Legacy table presentational attributes join the zero-loss scope** — `align`/`valign`/`bgcolor`/`width`/`height`/`border`/`cellpadding`/`cellspacing` on `table`/`tr`/`td`/`th` must round-trip instead of being silently dropped by the import sanitizer; until the editor can represent them, a table carrying them is preserved whole as an opaque region (byte-exact, not editable inline) rather than editable-but-stripped. (b) **Forward threading is verified on real Gmail:** a forward carries only `threadId` plus the `Fwd:`-prefixed subject (no reply headers, `replyPlan.ts`), and an owner test shows it lands in the source conversation — T14B/T16's open observation is closed. (c) **The lifetime `has:attachment` walk is approved:** an ids-only `q=has:attachment` listing pass (~1% of sweep cost) sets thread-level attachment flags lifetime-wide, so attachment chips and local `has:attachment` search are trustworthy before hydration. (d) **`N`/`P`/`O` reader keys will be bound** (next/previous message, expand/collapse), not cut from §5; the M3 palette-completeness assertion covers them.
