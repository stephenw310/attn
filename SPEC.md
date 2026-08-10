# Attn — Product & Technical Spec (v0.6)

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
- Full-width conversation list + overlay conversation view, threaded conversations
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

**D5 — SQLite + FTS5 as the local store.** All metadata for the last 12 months, full bodies for the last 90 days, older bodies fetched on demand and cached. Search runs entirely locally against FTS5.

**D6 — Visual direction: "Dispatch" (settled 2026-08-09; mockups in `design/explorations/b2-*.html`).** Cool deep graphite surfaces, one amber signal color, a single sans family with tabular numerals doing the instrument work, and the lowercase `attn:` wordmark with an accent colon. Signature element: the **queue readout** ("● ● ● ○ ○ · 3 to zero") persistent in the top bar. Layout is sequential (D6 supersedes the original two-pane F3): full-width list ⇄ centered conversation overlay. Splits render as a horizontal strip (hot splits carry counts; overflow behind `···`; full jump-list in the palette). Settings live behind the account-chip menu (Settings, keyboard shortcuts, split rules, sign out) — no hamburger. Light theme derives from the same tokens at M3 (F14).

**Modifier convention:** `Mod` = `Cmd` on macOS, `Ctrl` on Windows. All shortcuts in this spec are written platform-neutrally.

> **On fidelity:** keyboard bindings, layouts, and behavioral details in this spec are *our* defaults — Gmail-compatible where sensible, inspired by Superhuman's philosophy, but not claimed to be an exact replica of Superhuman's bindings or UI.

---

## 4. Feature specifications

### F1 — Onboarding & auth

Sign in with Google via OAuth 2.0 **authorization-code + PKCE, loopback redirect** (opens system browser, redirects to `http://127.0.0.1:<port>`). Requested scopes: `gmail.modify` (covers read, label changes, and send) plus basic profile/email.

Tokens are stored via Electron `safeStorage` (macOS Keychain / Windows DPAPI). No credentials ever touch disk in plaintext.

⚠️ **Real-world constraint:** `gmail.modify` is a restricted scope. **Decision for v1: dev-mode distribution** — each user supplies their own Google Cloud OAuth client (unverified-app warning is expected). Google's app verification + security assessment is deferred until/unless there is a public release (§9).

**Acceptance criteria**
- Fresh install → signed in and reading first conversations in under 60s on a typical inbox (metadata streams in; UI is usable before backfill completes).
- Revoking access from Google account settings degrades gracefully to a re-auth prompt, never a crash or silent hang.

### F2 — Sync engine & offline

**Backfill:** on first sync, fetch all labels, thread/message metadata for the last 12 months (headers, snippets, label sets), then message bodies for the last 90 days, newest first. Older content is fetched on demand and cached permanently. UI renders as soon as the first page of metadata lands.

**Incremental:** poll `history.list` from the last stored `historyId` (15s foreground / 60s background). On `historyId` expiry (HTTP 404), fall back to a delta re-list. All writes funnel through a single reducer so server-originated and locally-originated changes apply identically.

**Action queue:** every user action (archive, label, star, send…) is:
1. Applied to the local store immediately (optimistic).
2. Appended to a durable queue (`action_queue` table).
3. Executed against the Gmail API with retries + exponential backoff. Label operations are naturally idempotent. Send is guarded by an outbox state machine (see F6) so it executes **exactly once**.

Conflict rule: server state wins, except locally-pending actions replay on top of it.

**Acceptance criteria**
- Airplane mode: archive 20 conversations, quit the app, relaunch online → all 20 sync; none lost, none duplicated.
- Kill the app mid-sync → no corruption; next launch resumes from stored `historyId`.
- A change made in Gmail web (e.g. archive) is reflected locally within one poll interval.

### F3 — Inbox list & conversation overlay

**Sequential views, one clear focus** (decided with D6 — replaces the original two-pane design): the list owns the full window while deciding; an opened conversation presents as a **centered overlay above the dimmed list**, keeping the queue spatially present without competing for attention.

- The full-width virtualized list shows sender(s), subject, a 1–2 line snippet, timestamp, and chips (attachment, starred, snoozed-return, follow-up). Unread rows are visually distinct.
- `J`/`K` (and arrow keys) move the selection. Nothing renders in the periphery while triaging — envelope info only.
- `Enter` opens the overlay: centered column (~780px), thread position ("4 of 12") + `Esc` affordance in its header, older messages collapsed, quoted trails behind a toggle. `Esc` closes back to the list with selection preserved; `J`/`K` inside the overlay move to next/previous conversation directly.
- Bodies for the selected and adjacent conversations are preloaded so opening never shows a spinner.
- **Auto-advance:** after done/snooze/trash, selection (or the open overlay) moves to the next conversation automatically (setting: next / previous / back to list).

**Acceptance criteria**
- 60fps scroll on a 10,000-thread list.
- Opening a cached conversation renders in < 50ms; `Esc` returns instantly with scroll + selection intact.
- Auto-advance never lands on a stale (just-triaged) row.

### F4 — Triage actions & undo

| Action | Behavior |
|---|---|
| **Mark done** (`E`) | Removes from inbox (Gmail archive). The signature triage verb. |
| **Snooze / Remind later** (`H`) | Leaves the inbox now, returns at a chosen time. Picker offers presets (Later today, Tonight, Tomorrow, This weekend, Next week) + natural-language input ("thu 2pm", "in 3 days"). Implementation: remove `INBOX`, add app label `[Attn]/Snoozed`, store local due-time; at due time (or next launch) restore to inbox with a "returned" chip. **A new reply wakes the thread immediately** (configurable). |
| **Trash** (`#`) | Moves to Gmail trash. No permanent delete anywhere in v1. |
| **Star** (`S`) | Toggles star. |
| **Unread** (`U`) | Toggles read state. |
| **Spam** (`!`) | Reports spam. |
| **Label** (`L`) | Opens label picker (search-as-you-type, add/remove). |
| **Select** (`X`) | Toggles selection; `Shift+click`/`Shift+J/K` extends. All triage verbs operate on the selection when one exists. |
| **Undo** (`Z`) | Reverses the last action — including bulk actions — from a session-scoped stack (last 50 actions). Every destructive-feeling verb is instantly reversible; this is what makes fearless triage possible. |

**Acceptance criteria**
- Any triage action gives visual feedback in < 16ms (optimistic), including on selections of 100+ conversations.
- `Z` fully reverses a bulk archive of 100 conversations, locally and (after sync) server-side.
- A snoozed thread returns within 60s of its due time while the app runs, or immediately on next launch if it was closed; a reply during snooze surfaces it immediately.
- Snoozed threads are always findable in a "Snoozed" view (`G` then `H`).

### F5 — Command palette

`Mod+K` opens the palette from anywhere. It is the app's primary control surface:

- Fuzzy-matches every registered command: triage verbs with arguments ("Remind me tomorrow 9am"), navigation ("Go to Sent"), settings ("Switch theme"), snippets ("Snippet: intro").
- Parameterized commands accept inline arguments with natural-language parsing where applicable (snooze and reminder times).
- Each result shows its keyboard shortcut — the palette is also how users learn the keys.
- Ranking: exact prefix > fuzzy score, with recently/frequently used commands boosted.
- **Engineering rule:** every user-facing feature must register a palette command. No feature ships reachable only by mouse.

**Acceptance criteria**
- Opens in < 50ms; results re-rank per keystroke in < 30ms.
- Every spec'd feature in this document is invocable from the palette.

### F6 — Compose, send & undo send

Composing opens an **overlay panel** above the inbox (context is never lost). `C` for new mail; `R`/`A`/`F` for reply/reply-all/forward with quoted history attached but collapsed.

- **Recipient autocomplete** ranked by interaction frequency + recency, built locally from synced sent mail. First suggestion accepted with `Tab`/`Enter`.
- **Rich text:** bold/italic/underline, bulleted & numbered lists, links, blockquote. Nothing more in v1.
- **Attachments:** drag-and-drop or picker, up to Gmail's 25MB limit, with progress indication.
- **Drafts:** autosaved locally every second while idle and synced to Gmail Drafts, crash-safe.
- **Send:** `Mod+Enter`.
- **Undo send:** sending holds the message in a local outbox for a configurable delay (0/5/**10**/20/30s, default 10). A toast shows "Sent — Undo (Z)". Undo reopens the composer with everything intact. The API call happens only after the window elapses.
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
- Content older than the synced window: a "Search all of Gmail" row runs the same query server-side (Gmail `q=`) and merges results.

**Acceptance criteria**
- p95 < 100ms for local queries on a 50,000-message store.
- Operators combine (e.g. `from:acme.com has:attachment after:2026-01-01`).

### F11 — Split inbox

The inbox is divided into **splits** — tabs above the list, each an independently triaged queue:

- Defaults: **Important** (Gmail's importance/category signals) and **Other**.
- User-defined splits match rules on: sender address, sender domain, mailing-list (`List-Id`), or label. First matching split wins (user orders them); every thread appears in exactly one split. Splits are views — mail is never moved by splitting.
- Navigate: `←`/`→` between splits; each split keeps its own selection and unread count.
- **Strip scaling (D6):** splits render as a horizontal top-bar strip — hot splits show unread counts, cold ones stay quiet, and past ~8 the strip scrolls with overflow behind `···`. The full jump-list lives in the palette ("Go to: <split>"). Chrome stays proportional to hot lanes, not total lanes.
- Per-split notification settings (see F12): by default only Important notifies.

**Acceptance criteria**
- Split switch < 50ms with selection preserved per split.
- Rule changes re-bucket the inbox in < 1s for 10k threads, with no thread appearing in two splits.

### F12 — Notifications & badging

- Native OS notifications (macOS Notification Center / Windows toast) for new mail in notification-enabled splits: sender + subject + snippet; click opens the thread.
- Unread badge: macOS dock badge; Windows taskbar overlay. Counts only notification-enabled splits (i.e., the number that matters, not all mail).
- Notification latency is bounded by polling: ≤ ~30s foregrounded (D2).

### F13 — Inbox zero

When a split reaches zero, the list pane is replaced by a full-pane zero state: a rotating background image, a short affirmation, the time, and a hint of remaining splits with counts ("Other: 12"). Reaching zero should feel like a reward.

### F14 — Themes

Light and dark themes; follows the OS by default with a manual override (palette: "Switch theme"). Dark is the Dispatch base (D6); the light variant is derived from the same tokens at M3. All UI, including rendered HTML mail, must be legible in both (dark mode sanitizes/inverts mail backgrounds where safe, with a per-message "view original" escape hatch).

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
| `Esc` | Back / close overlay |
| `Mod+/` | Keyboard cheat sheet |
| `Mod+,` | Settings |

**List & navigation**

| Keys | Action |
|---|---|
| `J` / `K` (or `↓`/`↑`) | Next / previous conversation |
| `Enter` | Open conversation |
| `←` / `→` | Previous / next split |
| `X` | Select conversation (`Shift+J/K` extends) |
| `G` then `I` | Go to Inbox |
| `G` then `T` | Go to Sent |
| `G` then `D` | Go to Drafts |
| `G` then `S` | Go to Starred |
| `G` then `H` | Go to Snoozed / Reminders |

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
| `R` / `A` / `F` | Reply / reply-all / forward |
| `N` / `P` | Next / previous message in thread |
| `O` | Expand / collapse message |

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
│  Renderer (React + TS)          Utility process (Node + TS)    │
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
- **Sync engine lives in a utility process** so backfill/indexing can never jank the UI.
- **One reducer, two sources:** server history events and local optimistic actions flow through the same state-transition code, which is what keeps optimistic UI and sync convergent.
- **Scheduler** owns every timer (snooze due-times, follow-up deadlines, undo-send windows); on launch it executes anything that came due while the app was closed (catch-up, D2).

**Local schema (core tables):** `accounts`, `threads`, `messages`, `bodies` (FTS5 external-content), `labels`, `thread_labels`, `contacts` (with frequency/recency stats), `splits`, `snippets`, `reminders` (snooze + follow-up), `outbox`, `action_queue`, `sync_state`, `settings`. Every row keyed by `account_id` (D4).

**Security & privacy:** OAuth tokens and LLM API keys via `safeStorage` (Keychain/DPAPI); DB under the OS user profile; TLS to Google only — plus the opt-in LLM provider (F17), which receives content solely on explicit invocation; **no telemetry, no other third-party services** in v1. Remote images in HTML mail load directly (no proxy without a server, D2), with a global "block remote images" toggle and per-sender overrides — default is load (decision log, §9).

**HTML mail rendering:** sanitized (DOMPurify-class allowlist), rendered in a sandboxed `<iframe>`/webview with no script execution, links open in the system browser.

**Packaging:** `electron-builder`; auto-update via GitHub Releases. macOS notarization + Windows code signing required for public distribution (skippable for personal builds).

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

Budgets are CI-tracked once M1 lands: a perf smoke test fails the build on >20% regression.

---

## 8. Milestones

Each milestone ends in a usable app; the daily-drivable bar is M2.

- **M0 — Walking skeleton.** Electron shell (both OSes), Google OAuth, metadata backfill into SQLite, read-only list + reading pane, `J/K/Enter/Esc`. *Proves: auth, sync, and the 60fps list.*
- **M1 — Triage core.** First items: **apply the Dispatch direction** (D6 — graphite/amber tokens, `attn:` wordmark, list ⇄ overlay layout replacing two-pane, split strip, account menu) and **sanitized HTML mail rendering** (allowlist sanitizer + sandboxed iframe per §6 — triaging means reading real mail; M0 shipped plain-text bodies only). Then: done/snooze/trash/star/unread/label, selection + bulk, auto-advance, `Z` undo, durable action queue + offline replay, snooze scheduler, tray/background mode + launch at login, basic notifications. *Proves: the core loop and offline correctness.*
- **M2 — Mail out.** Composer (rich text, attachments, autocomplete), reply/all/forward, crash-safe drafts, send + undo send, exactly-once outbox. **← daily-drivable.**
- **M3 — Find & focus.** FTS5 instant search + operators, split inbox + rules, inbox-zero states, themes, command palette hardened (every command registered).
- **M4 — Power finish.** Snippets, follow-up reminders, AI reply drafting (F17), settings surface, badges, packaging + auto-update + signing.

**Post-v1 sequence:** v1.1 — global-hotkey quick panel (quick compose + quick search) and multi-account (switcher `Mod+1..9`; unified inbox stays out). v1.5 — companion Apps Script: send later + exact-time snooze return (F7). v2 — hosted backend: read statuses, true multi-device state.

**Success metrics (post-M2 dogfood):** p95 action latency vs. budget, % of actions invoked via keyboard (target > 80%), time-to-zero on a 50-conversation morning inbox (target < 15 min), crash-free sessions > 99.5%.

---

## 9. Decision log (all open questions resolved 2026-08-09)

1. **Multi-account:** not in v1. Moved out of the M4 stretch into v1.1, alongside the quick panel. Data model stays multi-account-ready (D4).
2. **OAuth distribution:** dev-mode for v1 — each user supplies their own Google OAuth client; Google verification deferred until/unless a public release (F1).
3. **Read statuses:** out of v1; revisit at v2 with the hosted backend (D2).
4. **Shell:** Electron confirmed over Tauri — one rendering engine and one language outweigh Tauri's footprint advantages for this app (D3).
5. **Remote images in HTML mail:** default load, with the global block toggle and per-sender overrides (§6 Security).
6. **Snooze reinstall durability:** accepted — a reinstall loses local due-times; snoozed threads remain findable in the Snoozed view and are restored to the inbox with a notice. A reinstall isn't expected to preserve local state.
