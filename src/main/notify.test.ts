import { describe, expect, it } from 'vitest'
import type { Db } from './db'
import type { NotificationCandidate } from './notify'
import {
  applyUnreadBadge,
  BoundedRetainer,
  candidatesFor,
  isolateNotificationFailure,
  notificationPausedUntil,
  oneHourFrom,
  PENDING_FOCUS_TTL_MS,
  planNotifications,
  setNotificationPausedUntil,
  takePendingFocus,
  tomorrowStart
} from './notify'

function mail(threadId: string, overrides: Partial<NotificationCandidate> = {}): NotificationCandidate {
  return {
    threadId,
    messageId: `message-${threadId}`,
    sender: `Sender ${threadId}`,
    subject: `Subject ${threadId}`,
    snippet: `Snippet ${threadId}`,
    ...overrides
  }
}

describe('planNotifications', () => {
  it('creates one sender, subject, and snippet notification for up to three threads', () => {
    expect(
      planNotifications([mail('one'), mail('two'), mail('three')], {
        focused: false,
        now: 1_000
      })
    ).toEqual([
      {
        threadId: 'one',
        title: 'Sender one · Subject one',
        body: 'Snippet one'
      },
      {
        threadId: 'two',
        title: 'Sender two · Subject two',
        body: 'Snippet two'
      },
      {
        threadId: 'three',
        title: 'Sender three · Subject three',
        body: 'Snippet three'
      }
    ])
  })

  it('summarizes more than three new conversations and deduplicates messages by thread', () => {
    expect(
      planNotifications([mail('one'), mail('two'), mail('three'), mail('four'), mail('four')], {
        focused: false
      })
    ).toEqual([{ title: 'Attn', body: '4 new conversations' }])
  })

  it('falls back to placeholders when a message has no sender or subject', () => {
    expect(planNotifications([mail('one', { sender: '', subject: '' })], { focused: false })).toEqual([
      { threadId: 'one', title: 'New message · (no subject)', body: 'Snippet one' }
    ])
  })

  it('suppresses notifications while focused or paused', () => {
    expect(planNotifications([mail('one')], { focused: true })).toEqual([])
    expect(planNotifications([mail('one')], { focused: false, pausedUntil: 1_001, now: 1_000 })).toEqual([])
    expect(planNotifications([mail('one')], { focused: false, pausedUntil: 1_000, now: 1_000 })).toHaveLength(
      1
    )
  })
})

describe('tomorrowStart', () => {
  it('returns local midnight at the start of the next day', () => {
    const now = new Date(2026, 7, 11, 17, 42, 30)
    expect(tomorrowStart(now)).toBe(new Date(2026, 7, 12).getTime())
  })
})

describe('notification pause settings', () => {
  it('persists one-hour and tomorrow pauses and resumes notifications', () => {
    const { db, values } = fakeSettingsDb()
    const now = new Date(2026, 7, 11, 17, 42, 30)

    setNotificationPausedUntil(db, oneHourFrom(now.getTime()))
    expect(notificationPausedUntil(db)).toBe(now.getTime() + 60 * 60 * 1000)
    expect(values.get('notificationsPausedUntil')).toBe(String(now.getTime() + 60 * 60 * 1000))

    setNotificationPausedUntil(db, tomorrowStart(now))
    expect(notificationPausedUntil(db)).toBe(new Date(2026, 7, 12).getTime())

    setNotificationPausedUntil(db, null)
    expect(notificationPausedUntil(db)).toBeNull()
  })
})

describe('badge effects', () => {
  it('is a no-op on Linux and maps unread counts on macOS and Windows', () => {
    const calls: string[] = []
    const effects = {
      setMacBadge: (count: number): void => {
        calls.push(`mac:${count}`)
      },
      setWindowsOverlay: (show: boolean, description: string): void => {
        calls.push(`windows:${show}:${description}`)
      }
    }

    applyUnreadBadge('linux', 4, effects)
    expect(calls).toEqual([])
    applyUnreadBadge('darwin', 4, effects)
    applyUnreadBadge('win32', 4, effects)
    applyUnreadBadge('win32', 0, effects)
    expect(calls).toEqual(['mac:4', 'windows:true:4 unread conversations', 'windows:false:'])
  })
})

describe('notification failure isolation', () => {
  it('reports notification errors without rethrowing into the sync poller', () => {
    const messages: string[] = []
    expect(() =>
      isolateNotificationFailure(
        () => {
          throw new Error('database is locked')
        },
        (message) => messages.push(message)
      )
    ).not.toThrow()
    expect(messages).toEqual(['database is locked'])
  })
})

describe('takePendingFocus', () => {
  it('honours a fresh target and drops one nothing picked up in time', () => {
    expect(takePendingFocus(null)).toBeNull()
    expect(takePendingFocus({ threadId: 't-budget', at: 1_000 }, 1_000 + PENDING_FOCUS_TTL_MS)).toBe(
      't-budget'
    )
    expect(takePendingFocus({ threadId: 't-budget', at: 1_000 }, 1_001 + PENDING_FOCUS_TTL_MS)).toBeNull()
  })
})

describe('candidatesFor', () => {
  it('excludes mail with no stored message from both the detail list and the count', () => {
    const db = fakeMailDb([
      { messageId: 'message-one', threadId: 'one' },
      { messageId: 'message-two', threadId: 'two' },
      { messageId: 'message-three', threadId: 'three' }
    ])
    // Four new threads arrive, but 'four' has no persisted message row. Counting
    // it would tip the batch over the threshold and summarize instead of listing.
    const candidates = candidatesFor(db, 'user@attn.test', [
      { threadId: 'one', messageId: 'message-one' },
      { threadId: 'two', messageId: 'message-two' },
      { threadId: 'three', messageId: 'message-three' },
      { threadId: 'four', messageId: 'message-four' }
    ])

    expect(candidates.map((candidate) => candidate.threadId)).toEqual(['one', 'two', 'three'])
    expect(planNotifications(candidates, { focused: false })).toHaveLength(3)
  })

  it('skips hydration above the threshold and still summarizes by that same count', () => {
    const stored = ['one', 'two', 'three', 'four'].map((threadId) => ({
      messageId: `message-${threadId}`,
      threadId
    }))
    const db = fakeMailDb(stored)

    // Guards the coupling between the two SUMMARY_THRESHOLD uses: hydration is
    // skipped here, so a threshold raised only in planNotifications would plan
    // detail notifications from blank rows.
    expect(planNotifications(candidatesFor(db, 'user@attn.test', stored), { focused: false })).toEqual([
      { title: 'Attn', body: '4 new conversations' }
    ])
  })
})

function fakeMailDb(inboxMessages: readonly { messageId: string; threadId: string }[]): Db {
  const byMessageId = new Map(inboxMessages.map((message) => [message.messageId, message]))
  return {
    prepare: () => ({
      all: (_accountId: string, ...messageIds: string[]) =>
        messageIds.flatMap((messageId) => {
          const message = byMessageId.get(messageId)
          return message ? [{ message_id: messageId, thread_id: message.threadId }] : []
        }),
      get: (_accountId: string, messageId: string) => {
        const message = byMessageId.get(messageId)
        if (!message) return undefined
        return {
          from_name: `Sender ${message.threadId}`,
          from_email: null,
          snippet: `Snippet ${message.threadId}`,
          subject: `Subject ${message.threadId}`
        }
      }
    })
  } as unknown as Db
}

function fakeSettingsDb(): { db: Db; values: Map<string, string> } {
  const values = new Map<string, string>()
  const db = {
    prepare: (sql: string) => ({
      get: (_accountId: string, key: string) => {
        const value = values.get(key)
        return value === undefined ? undefined : { value }
      },
      run: (_accountId: string, key: string, value?: string) => {
        if (sql.startsWith('DELETE')) values.delete(key)
        else if (value !== undefined) values.set(key, value)
        return { changes: 1 }
      }
    })
  } as unknown as Db
  return { db, values }
}

describe('notification retention', () => {
  it('holds shown notifications so a collected object cannot swallow the click', () => {
    const retainer = new BoundedRetainer<object>(50)
    const banner = { id: 'shown' }
    retainer.retain(banner)
    expect(retainer.size).toBe(1)
  })

  it('releases a notification once its click has been handled', () => {
    const retainer = new BoundedRetainer<object>(50)
    const first = { id: 'first' }
    const second = { id: 'second' }
    retainer.retain(first)
    retainer.retain(second)
    retainer.release(first)
    expect(retainer.size).toBe(1)
    // Releasing something never retained (or released twice) is a no-op, not a throw.
    retainer.release(first)
    expect(retainer.size).toBe(1)
  })

  it('evicts the oldest beyond the cap rather than growing without bound', () => {
    const retainer = new BoundedRetainer<number>(3)
    for (const value of [1, 2, 3, 4, 5]) retainer.retain(value)
    expect(retainer.size).toBe(3)
    // The evicted entries are the oldest, which are the least likely to be clicked.
    retainer.release(4)
    retainer.release(5)
    expect(retainer.size).toBe(1)
  })

  it('drops every reference when the notifier stops', () => {
    const retainer = new BoundedRetainer<object>(50)
    retainer.retain({})
    retainer.retain({})
    retainer.clear()
    expect(retainer.size).toBe(0)
  })
})
