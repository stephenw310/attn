# Tide implementation tasks

This proposal turns the approved Tide mockups into implementation tasks. It changes no application behavior.
The reference was frozen on September 8, 2026, against commit `fb9ebac`.

Keep task discussion and completion status in the implementation PRs. This document is a handoff snapshot,
not a permanent progress tracker. Update `docs/SPEC.md` with accepted behavior changes as they ship.

## Open the approved brief

Download and extract [approved-brief.zip](approved-brief.zip). Serve the extracted directory locally:

```sh
python3 -m http.server 4325 --bind 127.0.0.1 --directory tide-brief
```

Open <http://127.0.0.1:4325/gallery.html>. Use another free port if 4325 is occupied.
The archive contains the interactive brief, its assets, and 266 light and dark renders for 133 states.
The gallery groups them into 33 families. Select a state within a family to compare variants.

`brief-manifest.json` maps each state to a URL, render, and source module. The source and shortcut inventories
are snapshots, not live product specifications. The prototype uses simulated data and simplified interactions.
Use it for appearance and interaction intent. Implement through the existing React components and command registry.
Do not port its accumulated HTML overrides into production.

## Delivery order

| Batch | Tasks | Depends on | Review outcome |
| --- | --- | --- | --- |
| 1. Foundations | T01–T03 | None | Shared styles and saved palette preference |
| 2. Shell and inbox | T04–T06 | Batch 1 | A complete inbox experience for the first visual review |
| 3. Reader | T07–T09 | Batch 2 | Conversation navigation and safe message display |
| 4. Composer | T10–T13 | Batches 1 and 3 | Dedicated and inline writing with existing draft guarantees |
| 5. Settings and rules | T14–T16 | Batches 1 and 2 | Actual settings, account scope, and split editing |
| 6. Remaining interactions and release review | T17–T20 | Shared controls first; final review after all batches | Complete coverage and keyboard regression checks |

Make each task a reviewable PR, or combine adjacent small tasks when their changes cannot be separated cleanly.
Review batches 1 and 2 together before applying the visual system to the remaining screens.
Include each task's loading, empty, error, and keyboard behavior in that task. Batch 6 is not a place to defer them.

Every implementation task must:

- Link its brief family and exact state URLs in the PR description.
- Preserve existing behavior unless the task explicitly calls for a change.
- Update the specification for changed behavior and add commands for new user-facing features.
- Add meaningful end-to-end coverage in the same PR. Use `data-testid` and existing shared test drivers.
- Run `npm run verify` and inspect affected screenshots in `e2e/.artifacts/`.
- Check light and dark appearance, keyboard focus, and layouts at the supported minimum window size.

## Batch 1. Foundations

### T01. Define semantic theme tokens

Start with `src/renderer/src/theme.tsx`, `themeTokens.test.ts`, and existing renderer styles.
Define shared tokens for backgrounds, elevated panels, text, borders, focus, selection, and status colors.
Add Matcha, Mist, Linen, and Dusk values for both appearances.

Acceptance:

- Components consume semantic tokens instead of adding their own palette-specific colors.
- Secondary text meets WCAG AA normal-text contrast. Focus and control boundaries remain distinguishable.
- Dark popovers and dialogs separate from the page without a bright inverse panel.
- Mail HTML keeps its existing sender styling and sandbox behavior.

Validation: extend theme token coverage and `e2e/theme.spec.ts`. Compare representative pages in all eight combinations.

### T02. Standardize controls and shortcut hints

Create or consolidate shared button, keycap, field, menu, dialog, and notification styles.
Apply these first to a small component sample or existing screen to settle sizing and focus treatment.

Acceptance:

- Primary actions use the approved filled treatment. Secondary actions have no resting outline and gain a subtle hover fill.
- Fields, keycaps, and attachment chips retain their intentional boundaries.
- Every displayed shortcut uses the same keycap component, including search prompts and Escape actions.
- Icon-only controls have accessible names. Focus indicators do not depend on hover.
- Dialogs restore focus to their trigger. Shortcut labels reflect actual command bindings.

Validation: cover keyboard activation and focus restoration for shared controls. Reuse these styles in subsequent tasks.

### T03. Persist palette and appearance separately

Use `theme.tsx`, `hooks/useSettings.ts`, and `src/shared/settings.ts` to add the palette preference.
Keep System, Light, and Dark as a separate appearance choice. Treat palette as an app-wide setting.

Acceptance:

- Existing profiles receive a documented default without resetting saved appearance.
- Palette changes apply immediately, survive restart, and remain consistent when switching accounts.
- System appearance follows OS changes. Palette selection is available through settings and a command.
- Use existing preference storage. If a schema change is necessary, include the required automatic migration and upgrade tests.

Validation: preference unit tests, restart persistence, account switching, and OS appearance coverage.

## Batch 2. Shell and inbox

### T04. Rebuild shell spacing and navigation

Update `App.tsx`, `components/MailSidebar.tsx`, and `components/MailHeader.tsx`.
Use mailbox icons with names and a flat label list with associated colors.

Acceptance:

- Hiding the sidebar hides the logo and the entire sidebar. There is no compressed icon rail.
- Write stays at the same position outside the sidebar. The hint toggle sits beside the sidebar toggle.
- Sidebar entries show no chord shortcuts. Settings remains available through the account menu and commands.
- Settings and split editing omit the mail sidebar. Returning to mail restores the user's sidebar preference.
- Status information has the same quiet tone as the rest of the shell.

Validation: sidebar and hint toggling, focus order, account menu access, and narrow-window layout.

### T05. Style inbox rows and all mailbox states

Update `ThreadList.tsx`, `SimpleRowList.tsx`, `SplitStrip.tsx`, and `list/mailDisplay.ts`.
Cover the `inbox` and `mailboxes` brief families.

Acceptance:

- Labels are readable tinted chips. Stars, unread markers, returned mail, and follow-up indicators can coexist.
- Done uses a visible checkmark in All Mail. Do not introduce a Done mailbox.
- Snoozed rows show the return time. Preserve current ordering and mailbox membership rules.
- Bulk selection and actions remain keyboard accessible. Selection does not hide state markers.
- Split navigation uses the approved unboxed header layout and retains current rule behavior.

Validation: extend mail-layout, mixed-mail, snooze, and triage coverage using real fixture states.

### T06. Complete inbox zero and loading feedback

Update `InboxZero.tsx`, `SyncStatus.tsx`, and relevant list loading branches.
Cover `zero` and the loading, offline, error, and pagination states in `inbox`.

Acceptance:

- Reuse the existing coastal image. Distinguish an empty split from all splits being clear.
- Cached mail remains usable during offline and sync errors.
- Initial loading and loading another page do not move existing content or obscure keyboard selection.
- Retry and details actions preserve existing behavior.

Validation: loading and offline fixtures, zero-state screenshots, and pagination while a row is selected.

## Batch 3. Reader

### T07. Implement conversation layout and message navigation

Update `ConversationView.tsx` and `MessageCard.tsx`. Cover `conversation` and `message-actions`.

Acceptance:

- Support latest expanded, all expanded, individually collapsed messages, and an active earlier message.
- N and P move the active message. O toggles it. The active marker is a short accent line and avatar outline.
- Expanded headers remain quiet, without a filled banner across the row.
- Back to Inbox and Expand all messages use shared secondary controls.
- With no reply open, Back to Inbox shows an Escape keycap. Show one contextually correct Escape action.

Validation: `e2e/message-replies.spec.ts`, message focus/expansion, and narrow-window screenshots.

### T08. Preserve safe HTML and message details

Update `MessageBody.tsx`, `mailFrame.tsx`, and recipient details in `MessageCard.tsx`.
Cover `html`, `reader-states`, and the quoted-content variants in `conversation`.

Acceptance:

- Plain text, formatted mail, and branded HTML fit the reader without rewriting sender content.
- Recipient details expand from the recipient line. Display available From, To, Cc, Bcc, Reply-To, and date fields.
- Quoted content, remote images, blocked images, hydration errors, and attachments retain their existing controls.
- Keep DOMPurify, the scriptless sandbox, external-link checks, and remote-image authorization intact.

Validation: `e2e/html-mail.spec.ts`, hydration fixtures, and attachment/link behavior. Inspect light and dark HTML rendering.

### T09. Define inline reply placement and Escape ownership

Coordinate `ConversationView.tsx` and the composer. Cover `inline` and conversation reply variants.

Acceptance:

- A reply to an earlier message appears directly below that message. Later messages remain in the conversation.
- The editor aligns with the message body and uses subtle horizontal boundaries.
- Reply draft, Not sent, and save state distinguish authored content from received content.
- While replying, hide Back to Inbox. Show Save & close with an Escape keycap inside the reply.
- Escape saves and closes the reply before it can leave the reader. Restore a sensible message focus.

Validation: reply to latest and earlier messages, draft reopening, and nested Escape behavior.

## Batch 4. Composer

### T10. Restyle dedicated and inline composer chrome

Update `composer/Composer.tsx`, `ComposerChrome.tsx`, `ComposerFooter.tsx`, and `RecipientField.tsx`.
Cover `compose`, `recipients`, and signature variants.

Acceptance:

- Dedicated and inline composers share controls, spacing, recipient chips, and save-state styling.
- Cc, Bcc, sender selection, invalid addresses, and recipient suggestions preserve existing behavior.
- Signatures render as message content without an extra panel box.
- Attachment and remind-me controls remain next to the existing sending controls.
- Draft errors remain visible. Save and close never imply that the message was sent.

Validation: `e2e/composer.spec.ts` and message-reply coverage, including recipients and restored signatures.

### T11. Add selection formatting with an Aa fallback

Adapt `composer/EditorToolbar.tsx` and the existing Lexical integration.
Cover `format`. Keep the current editor package.

Acceptance:

- Selecting editable text opens a positioned toolbar without losing the selection.
- Aa exposes equivalent formatting for keyboard users and when no selection toolbar is available.
- Toolbar actions preserve selection, undo history, and existing formatting support.
- Read-only signatures and opaque imported HTML remain protected.
- Toolbar placement stays inside the visible editor area and does not overlap necessary controls.

Validation: format selected text in both composers, keyboard-only fallback, collapsed selection, and undo/redo.

### T12. Preserve attachments, reminders, drafts, and send recovery

Update `useComposerAttachments.ts`, `FollowUpControl.tsx`, `DraftList.tsx`, and `OutboxList.tsx`.
Cover `attachments`, `reminder`, `drafts`, and `outbox`.

Acceptance:

- Show upload progress, failure, removal, and attachment actions using shared styles.
- Keep the reminder bell visible, with the existing deadline and no-reply behavior.
- Distinguish saving, saved locally, save failure, queued, sending, failed, and needs-review states.
- Undo-send uses the configured delay, not the mock's example duration.
- Preserve draft revisions, account ownership, and uncertain-send recovery. Never turn an uncertain send into a blind retry.

Validation: existing draft/outbox tests, injected timer tests, account-switch guards, and failure screenshots.

### T13. Match AI writing and snippet interactions

Update `AiDraftPlugin.tsx`, `AiAutocompletePlugin.tsx`, `SnippetsPlugin.tsx`, and `SnippetManager.tsx`.
Cover `ai` and `snippets`.

Acceptance:

- Show the generate invitation, stream into the authored body, then show the refine input pill.
- Escape stops the active AI interaction before closing the composer. Preserve authored text and undo behavior.
- Keep autocomplete consent and provider failures distinct from AI drafting states.
- Snippet selection, editing, empty results, and insertion use shared menus and fields.
- Preserve sanitization and protected imported content throughout generation and insertion.

Validation: existing AI draft, autocomplete, and snippet end-to-end tests, including cancellation and failures.

## Batch 5. Settings and rules

### T14. Reorganize actual settings by ownership

Update `SettingsView.tsx`, `AiSettingsSection.tsx`, and `AboutSection.tsx`.
Cover `settings`, `account-settings`, and `ai-settings`.

Acceptance:

- Use sentence-case navigation with explicit app-wide and current-account groups.
- App-wide settings include appearance, sending preferences, notifications, privacy, background behavior, AI, and snippets.
- Account settings retain their actual sync/storage and signature options. Show the current account beside the group.
- Preserve real option values and defaults from `src/shared/settings.ts`. Do not implement placeholder settings from a mock.
- Keep secrets in existing protected storage. Preserve AI consent and validation behavior.
- Remove the duplicate Inbox splits navigation entry from settings.

Validation: settings persistence and scope tests, account switching, provider validation, and settings screenshots.

### T15. Restyle split editing

Update `SplitRuleManager.tsx`. Cover `splits` and enter it from the inbox split control or command.

Acceptance:

- Preserve current condition types, any/all matching, notification options, and preset restore behavior.
- Preserve per-account ownership and the special Important and Other rules.
- Keep existing drag reordering and keyboard reordering. Omit duplicate Move up and Move down buttons.
- Validation errors and destructive actions use shared controls without making a destructive choice the default.

Validation: split-rule fixtures, reorder keyboard tests, invalid rules, and account isolation.

### T16. Complete account and sign-in screens

Update `LoginScreen.tsx`, `AccountHealthLine.tsx`, and `hooks/useAccountSession.tsx`.
Cover `accounts` and `login`.

Acceptance:

- Use the approved tidal illustration for sign-in, with readable text and controls in both appearances.
- Preserve add-account, reauthentication, switching, removal, and draft-blocked transitions.
- Present keep-local-data and delete-local-data sign-out choices without preselecting the destructive choice.
- Explain the consequence before confirmation. Preserve actual deletion and account-isolation behavior.

Validation: account restore/switching and sign-in error fixtures. Add explicit coverage for the changed sign-out choice presentation.

## Batch 6. Remaining interactions and release review

### T17. Complete command palette and shortcut reference

Update `CommandPalette.tsx`, `commandPalette.ts`, `CheatSheet.tsx`, and `commands.ts`.
Cover `palette` and `shortcuts`.

Acceptance:

- Palette search, empty results, command groups, and chord navigation share the approved selection treatment.
- The shortcut reference is a comprehensive grouped layout at desktop sizes, not a single long menu.
- Derive labels from actual commands. The current reference shortcut is Mod+/; do not relabel it Mod+?.
- Smaller windows can scroll accessibly without clipping groups or trapping focus.

Validation: command registry tests, keyboard palette interaction, and shortcut reference screenshots.

### T18. Complete search and triage pickers

Update `SearchHeader.tsx`, `ServerSearchRow.tsx`, `useSearchSession.ts`, `LabelPicker.tsx`,
`MovePicker.tsx`, `SnoozePicker.tsx`, and `PickerDialog.tsx`.
Cover `search`, `labels`, `move`, and `snooze`.

Acceptance:

- Local results, Gmail submission, loading, empty, and error states retain existing search semantics.
- Every search keyboard hint, including Enter to search Gmail, uses a keycap.
- Label colors and selected states remain visible in pickers. Preserve create/edit and multi-label behavior.
- Date parsing, invalid snooze input, move destinations, and focus restoration work with mouse and keyboard.

Validation: search, move, label, and snooze tests plus no-results and error screenshots.

### T19. Complete global feedback and native boundaries

Update `Toast.tsx`, `useToast.ts`, `SyncStatus.tsx`, and update/account status UI.
Cover `sync`, `updates`, `feedback`, and `native`.

Acceptance:

- General success, errors, upload feedback, and undo notices share a notification style.
- Undo countdown reflects the actual deadline and exposes the existing undo action.
- Sync and update details preserve actionable errors and progress without a high-contrast status strip.
- Treat the menu-bar mock as a reference for the existing native menu. Do not create an in-app menu-bar modal.
- Preserve OS-specific behavior on macOS and Windows.

Validation: injected timer coverage, update fixtures, status/error screenshots, and native-menu smoke checks on supported platforms.

### T20. Reconcile coverage and validate the completed application

After all tasks, compare the running application with every family and state in the frozen manifest.
Record mismatches in the implementation PR and fix them before calling the redesign complete.

Acceptance:

- Every manifest state has an implementation reference or a documented reason it is only a prototype example.
- Inspect all eight palette/appearance combinations across representative screens and all affected light/dark screenshots.
- Check minimum window size, long subjects, many labels, long recipient lists, scroll behavior, and focus visibility.
- Verify Escape ownership, N/P/O navigation, shortcut keycaps, and focus restoration across nested interactions.
- Run the full verification suite. Check draft durability, account isolation, HTML safety, and uncertain-send recovery regressions.
- Update `docs/SPEC.md` for shipped behavior and remove obsolete implementation-only styles.

## Brief coverage map

The ownership below covers all 33 families. A family shared by tasks must remain covered across both PRs.

| Brief families | Owning tasks |
| --- | --- |
| inbox, mailboxes | T04, T05, T06 |
| zero | T06 |
| conversation, message-actions | T07, T08, T09 |
| inline | T09, T10 |
| reader-states, html | T08 |
| compose, recipients | T10 |
| format | T11 |
| attachments, reminder, drafts, outbox | T12 |
| ai, snippets | T13 |
| settings, account-settings, ai-settings | T03, T14 |
| splits | T15 |
| accounts, login | T16 |
| palette, shortcuts | T17 |
| search, labels, move, snooze | T18 |
| sync, updates, feedback, native | T19 |

T01 and T02 apply to every family. T20 checks the complete application.

## Scope and implementation constraints

The redesign preserves the current mail data model, account boundaries, IPC ownership, and sending guarantees.
The main intended behavior additions are saved color palettes and selection-based formatting with a fallback.
Contextual Escape handling and sign-out choice presentation also need explicit specification and regression coverage.

The archive includes source audits and prior prototype checks as design evidence. They do not establish production test coverage.
Use the current specification and runtime code when a simplified mock disagrees with existing mail behavior.
