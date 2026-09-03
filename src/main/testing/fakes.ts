// Test-only construction helpers. Imported from `*.test.ts` alone, so nothing
// here reaches a bundle; it exists because a dozen suites hand-rolled the same
// full `MailProvider` of stubs and the same injectable clock, and the copies
// disagreed on which optional members they bothered to define.

import { vi } from 'vitest'
import type { MailProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerFactory, type TimerHandle } from '../time'

/**
 * A complete `MailProvider` whose every member is a `vi.fn()` returning the
 * empty answer. Pass overrides for the calls the test actually drives; the rest
 * stay assertable spies rather than missing members.
 */
export function fakeMailProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'test@example.com', historyId: '101' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async (id: string) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '101' })),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id: string) => ({
      id,
      message: { id: `message-${id}`, threadId: `thread-${id}` }
    })),
    ...overrides
  }
}

export interface FakeSchedulerTime extends SchedulerTime {
  /** Move the reported clock. Timers are separate: they run on Vitest's. */
  advance(ms: number): void
  set(value: number): void
}

export interface FakeSchedulerTimeOptions {
  start?: number
  /**
   * `'real'` (the default) delegates to the platform timers, so a test drives
   * them with `vi.useFakeTimers()`. `'inert'` accepts timers that never fire —
   * for suites that assert a runner reaches its next request without waiting.
   * `'immediate'` runs every timer synchronously, collapsing pacing to nothing.
   */
  timers?: 'real' | 'inert' | 'immediate'
}

const FAKE_TIMERS: Record<Required<FakeSchedulerTimeOptions>['timers'], TimerFactory> = {
  real: systemTime.timers,
  inert: { setTimeout: () => 0 as unknown as TimerHandle, clearTimeout: () => {} },
  immediate: {
    setTimeout: (callback) => {
      callback()
      return 0 as unknown as TimerHandle
    },
    clearTimeout: () => {}
  }
}

/** An injectable clock the test moves by hand, for anything time-driven. */
export function fakeSchedulerTime(options: FakeSchedulerTimeOptions = {}): FakeSchedulerTime {
  let now = options.start ?? 0
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (value) => {
      now = value
    },
    timers: FAKE_TIMERS[options.timers ?? 'real']
  }
}
