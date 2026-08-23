import { expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { type Db, openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { saveDraft } from './drafts'
import { DraftMirrorRowError, type drainDraftMirrors } from './mirror'
import { DraftMirrorExecutor } from './mirrorExecutor'

class ManualTime implements SchedulerTime {
  private current = 0
  private nextId = 1
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>()

  readonly timers = {
    setTimeout: (callback: () => void, delayMs: number): TimerHandle => {
      const id = this.nextId++
      this.scheduled.set(id, { at: this.current + delayMs, callback })
      return id as unknown as TimerHandle
    },
    clearTimeout: (handle: TimerHandle): void => {
      this.scheduled.delete(handle as unknown as number)
    }
  }

  now(): number {
    return this.current
  }

  nextDelay(): number | null {
    const next = [...this.scheduled.values()].sort((left, right) => left.at - right.at)[0]
    return next ? next.at - this.current : null
  }

  advance(ms: number): void {
    this.current += ms
    const due = [...this.scheduled.entries()].filter(([, timer]) => timer.at <= this.current)
    for (const [id, timer] of due) {
      this.scheduled.delete(id)
      timer.callback()
    }
  }
}

it('quiesces the active checkpoint before shutdown and declines another row', async () => {
  let release: () => void = () => {}
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve
  })
  const drain = vi.fn<typeof drainDraftMirrors>(async (_db, _accountId, _provider, shouldContinue) => {
    expect(shouldContinue?.()).toBe(true)
    await checkpoint
    expect(shouldContinue?.()).toBe(false)
  })
  const executor = new DraftMirrorExecutor(
    {} as Db,
    () => 'user@example.com',
    () => null,
    { time: systemTime, drainDrafts: drain }
  )

  const running = executor.trigger()
  expect(executor.isRunning()).toBe(true)
  let stopped = false
  const stopping = executor.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)

  release()
  await Promise.all([running, stopping])
  expect(stopped).toBe(true)
  expect(executor.isRunning()).toBe(false)
  await executor.trigger()
  expect(drain).toHaveBeenCalledOnce()
})

it('aborts a stalled checkpoint after the shutdown grace period', async () => {
  const time = new ManualTime()
  let observedSignal: AbortSignal | undefined
  const drain = vi.fn<typeof drainDraftMirrors>(
    async (_db, _accountId, _provider, _shouldContinue, _spoolRoot, signal) => {
      observedSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
  )
  const executor = new DraftMirrorExecutor(
    {} as Db,
    () => 'user@example.com',
    () => null,
    { time, drainDrafts: drain }
  )

  const running = executor.trigger()
  await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
  const stopping = executor.stop()
  expect(time.nextDelay()).toBe(5_000)

  time.advance(5_000)
  await Promise.all([running, stopping])

  expect(observedSignal?.aborted).toBe(true)
  await executor.trigger()
  expect(drain).toHaveBeenCalledOnce()
})

it('backs off a permanently rejected draft and mirrors later rows', async () => {
  const time = new ManualTime()
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
    'user@example.com',
    'user@example.com',
    1
  )
  const rejectedId = saveDraft(
    db,
    'user@example.com',
    { ...emptyDraftInput(), subject: 'Rejected draft' },
    10
  )
  const laterId = saveDraft(db, 'user@example.com', { ...emptyDraftInput(), subject: 'Later draft' }, 20)
  const attempted: string[] = []
  const saveRemote = vi.fn(async ({ raw }: { id: string | null; raw: string }) => {
    const message = Buffer.from(raw, 'base64url').toString()
    const subject = message.includes('Subject: Rejected draft') ? 'rejected' : 'later'
    attempted.push(subject)
    if (subject === 'rejected') throw new GmailApiError(400, 'draft rejected')
    return 'gmail-later'
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const executor = new DraftMirrorExecutor(
    db,
    () => 'user@example.com',
    () => ({ saveDraft: saveRemote }) as unknown as MailActionProvider,
    { time }
  )

  try {
    await executor.trigger()

    expect(attempted).toEqual(['rejected', 'later'])
    expect(db.prepare('SELECT mirror_revision FROM outbox WHERE id = ?').get(rejectedId)).toEqual({
      mirror_revision: 0
    })
    expect(db.prepare('SELECT mirror_revision FROM outbox WHERE id = ?').get(laterId)).toEqual({
      mirror_revision: 1
    })
    expect(time.nextDelay()).toBe(5_000)

    time.advance(4_999)
    expect(attempted).toEqual(['rejected', 'later'])
    time.advance(1)
    await vi.waitFor(() => expect(attempted).toEqual(['rejected', 'later', 'rejected']))
    await vi.waitFor(() => expect(time.nextDelay()).toBe(30_000))
  } finally {
    await executor.stop()
    log.mockRestore()
    db.close()
  }
})

it('keeps the provider paired with its account when authentication changes mid-drain', async () => {
  const time = new ManualTime()
  const providerA = {} as MailActionProvider
  const providerB = {} as MailActionProvider
  let activeAccount = 'account-a'
  let activeProvider = providerA
  let attempt = 0
  const accountId = vi.fn(() => activeAccount)
  const provider = vi.fn(() => activeProvider)
  const drain = vi.fn<typeof drainDraftMirrors>(async (_db, capturedAccount, capturedProvider) => {
    expect(capturedAccount).toBe('account-a')
    expect(capturedProvider).toBe(providerA)
    attempt += 1
    if (attempt === 1) {
      activeAccount = 'account-b'
      activeProvider = providerB
      throw new DraftMirrorRowError('draft-a', new GmailApiError(400, 'draft rejected'))
    }
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const executor = new DraftMirrorExecutor({} as Db, accountId, provider, { time, drainDrafts: drain })

  try {
    await executor.trigger()

    expect(drain).toHaveBeenCalledTimes(2)
    expect(accountId).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledOnce()
    expect(time.nextDelay()).toBe(5_000)
  } finally {
    await executor.stop()
    log.mockRestore()
  }
})
