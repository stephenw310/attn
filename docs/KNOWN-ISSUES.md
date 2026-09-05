# Known issues

This file records unresolved defects and validation gaps. Remove an entry when the work is complete. Do not keep completed reviews here.

## Manual validation gaps

These checks remain unrecorded in the repository. They are not confirmed product defects. Automated coverage exists, but it does not replace these checks.

| ID | Check still required | Automated coverage or implementation |
| --- | --- | --- |
| MANUAL-1 | Use Attn as the only mail client for seven consecutive days. Record failures and friction, including snippets, follow-ups, signatures, and AI if enabled. | Feature suites in `e2e/` |
| MANUAL-2 | With real Gmail, test forced-quit draft recovery and offline relaunch. Test undo send at several delays and crashes around remote draft creation and send. Confirm no duplicate messages. | `e2e/composer.spec.ts`, `src/main/outbox/` tests |
| MANUAL-3 | Send and receive real attachments, including inline images. Confirm that the Gmail signature and optional Attn footer survive the round trip. | `e2e/composer.spec.ts`, `e2e/settings.spec.ts` |
| MANUAL-4 | Open a real header-only message. Confirm body download, local persistence, and retry after a lost connection. | `e2e/hydration.spec.ts` |
| MANUAL-5 | Capture initial sync with a fresh profile and a long-lived Gmail mailbox. Record the measurements below. | `src/main/sync/`, `e2e/lifetime-sweep.spec.ts` |
| MANUAL-6 | On macOS and Windows, click a real notification and confirm the intended account and conversation open. | `e2e/notifications.spec.ts`, `e2e/accounts.spec.ts` |
| MANUAL-7 | Add a second real Gmail account during historical indexing. Confirm indexing priority, background mail actions, notification routing, and the combined unread badge. | `e2e/accounts.spec.ts`, `e2e/perf.spec.ts`, `src/main/db/isolation.test.ts` |
| MANUAL-8 | On both operating systems, test two-account settings, login startup, background pause and resume, and unread badges. Check the macOS menu-bar toggle. | `e2e/settings.spec.ts`, `e2e/background.spec.ts`, notification unit tests |
| MANUAL-9 | Change the historical sync limit against real Gmail. Test custom limits and All mail, resume after restart, and confirm a lower limit deletes nothing. Record disk use and elapsed time. | `e2e/settings.spec.ts`, `e2e/lifetime-sweep.spec.ts` |
| MANUAL-10 | Send mail with a follow-up reminder. Test cancellation by a real reply and return after a real expiry. | `e2e/follow-up.spec.ts`, `src/main/followUps.test.ts` |
| MANUAL-11 | Test AI drafting and autocomplete with a real provider. Record latency and request counts. Disable each feature and confirm its requests stop. | `e2e/ai.spec.ts`, `e2e/ai-draft.spec.ts`, `e2e/ai-autocomplete.spec.ts` |
| MANUAL-12 | Build and install personal packages on macOS and Windows without release credentials. Confirm no updater traffic or cached update installation. | `scripts/verify-package.mjs`, `e2e/update.spec.ts` |

For MANUAL-5, retain a redacted `[sync:metric]` log. Record mailbox thread and message counts, the configured quota, and these stages:

- First readable page and Inbox metadata readiness.
- Recent bodies and drafts.
- All Mail, Spam, Trash, and reconciliation.
- Historical headers and full background completion.

For each stage, record listed and fetched counts, elapsed time, threads per minute, and quota wait time. Do not use the unread badge as sync progress. Confirm that an older contact appears in autocomplete and that historical rows stay header-only until opened.

## Product defects

No unresolved product defect was established by this documentation cleanup. This is not a new whole-codebase audit. The prior review findings have later fix commits and must not be copied back as open bugs without reproduction.

For a new defect, record the symptom, steps to reproduce, affected symbol or test path, and verification date. Keep IDs stable and do not reuse them.
