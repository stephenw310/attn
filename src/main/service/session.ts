// The live per-account machinery one signed-in account owns (F18). The runtime
// builds one set per account; handlers and the e2e seams only ever see the
// active one, through `activeSession()`.

import type { ActionExecutor } from '../actions/executor'
import type { DraftMirrorExecutor } from '../outbox/mirrorExecutor'
import type { OutboxSender } from '../outbox/sender'
import type { SnoozeScheduler } from '../scheduler'
import type { SplitTriage } from '../sync/splitTriage'
import type { SyncController } from '../syncController'

export interface ServiceSession {
  readonly id: string
  /** True for seeded e2e accounts, which never talk to Gmail. */
  readonly seeded: boolean
  readonly syncController: SyncController
  readonly actionExecutor: ActionExecutor
  readonly draftMirrorExecutor: DraftMirrorExecutor
  readonly outboxSender: OutboxSender
  readonly snoozeScheduler: SnoozeScheduler
  /** The smart-splits classifier pass; idle unless the user turned it on. */
  readonly splitTriage: SplitTriage
}
