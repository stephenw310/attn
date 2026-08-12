import { describe, expect, it } from 'vitest'
import type { Db } from './db'
import type { NotificationCandidate } from './notify'
import {
  applyUnreadBadge,
  isolateNotificationFailure,
  notificationPausedUntil,
  oneHourFrom,
  planNotifications,
  setNotificationPausedUntil,
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
