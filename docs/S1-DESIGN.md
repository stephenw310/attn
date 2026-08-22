# S1 utility-process design

S1 moves Attn's local service layer into one Electron utility process. The utility owns the only SQLite
connection and every state machine that mutates it. The main process owns Electron APIs and supervises the
utility. The renderer API does not change.

## Ownership

| Main process | Utility process |
|---|---|
| Windows, tray, native notifications, badge effects | SQLite connection and schema initialization |
| OAuth loopback flow and `safeStorage` token file | Gmail client and quota limiter |
| File picker, download reveal, external links | Backfill, history poller, lifetime and attachment walks |
| Renderer IPC validation and forwarding | Query handlers and body hydration |
| Utility start, stop, crash detection, restart | Action executor and the shared thread reducer |
| Current focus state | Draft mirror, outbox sender, and snooze scheduler |
| | Notification candidate and unread-count queries |

The main process never opens `attn.db`. Unit tests may still construct an in-memory database because they test
the Electron-free service modules directly.

## Boundary protocol

Main and utility exchange a versioned, typed protocol over `utilityProcess.fork()` messaging:

- `initialize` carries paths, the optional deterministic test seed, current OAuth material, and window focus.
- `request` carries a request id, a service operation, and structured-clone-safe arguments.
- `response` returns the matching result or a serialized error.
- `control` updates authentication or focus and requests lifecycle work without creating a second owner.
- `event` carries renderer broadcasts, token refreshes, unread counts, notification candidates, and logs.

Renderer invokes keep their existing channel names and types. Main validates Electron-only input, performs the
small main-side part when needed, and forwards the store operation. The utility validates untrusted renderer
arguments again before touching the database.

## User-intent state machines

The action executor, draft mirror, and outbox sender move with SQLite. A renderer request only asks the utility
to enqueue or transition durable local state. The same process then claims the row and performs Gmail work.
This avoids the ambiguous case where a main-side executor loses an IPC reply and cannot tell whether the
utility committed its write.

The outbox keeps its existing protocol: persist a Gmail draft id before update or send, then verify ambiguous
remote outcomes by RFC Message-ID. A utility crash closes its SQLite connection and kills its network work.
The restarted utility reconstructs the executor from durable rows. There is still one call site allowed to
invoke Gmail `drafts.send`.

Server history and optimistic actions keep using `persistThread` and `applyThreadDelta`. The boundary does not
introduce a second reducer or a main-process fallback write.

## Crash and restart

The supervisor starts one utility, waits for its `ready` event, and only then opens renderer IPC. Unexpected
exit rejects in-flight requests and starts a fresh utility against the same database after a bounded delay.
There is no app restart and no database fallback in main.

Backfill, lifetime, and attachment walkers checkpoint complete pages in `sync_state`. After restart,
`SyncController` reads `backfill_cursor`, `sweep_cursor`, and `attachment_cursor` and resumes the unfinished
walk. Reprocessing the page whose remote fetch completed but whose checkpoint did not is safe because thread
and message writes are idempotent upserts.

Normal shutdown is different from a crash. Main asks the utility to stop. The utility first stops sync and the
action scheduler, lets the active draft mirror and outbox sender use their existing five-second quiesce path,
then closes SQLite and acknowledges shutdown. Main kills the child only if that bounded shutdown fails.

## Performance

Each renderer read adds one structured-clone request and response. The service returns the same bounded read
models as before, not database rows or SQL primitives. Performance e2e continues to measure the renderer call,
so cached conversation open still includes both hops and must remain below 50 ms.

Background indexing stays in the utility event loop and keeps the existing quota priorities and
`shouldYield` checks. Interactive body hydration, actions, and sends continue to outrank lifetime work.

## Test seams

Production and seeded e2e use the same supervisor and utility entry. Test-only IPC stays registered only under
`ATTN_TEST_USER_DATA`; main forwards database seams to the utility. The crash seam kills the child without a
graceful stop, waits for the supervisor's replacement `ready`, and lets the test assert the persisted cursor
and row counts through normal renderer APIs.

`SchedulerTime` remains injected into every timer-owning class. The process boundary does not add wall-clock
waits to unit tests.
