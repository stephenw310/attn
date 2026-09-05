import { describe, expect, it } from 'vitest'
import { oneHourFrom, tomorrowStart } from '../shared/notifications'
import { notificationPausedUntil, setNotificationPausedUntil } from './appSettings'
import { type Db, openDatabase } from './db'
import {
  acknowledgePendingFocus,
  applyUnreadBadge,
  applyUnreadBadgeToWindow,
  BoundedRetainer,
  notificationClickTarget,
  PENDING_FOCUS_TTL_MS,
  planNotifications,
  takePendingFocus
} from './notify'
import { candidatesFor, type NotificationCandidate } from './service/notificationQueries'

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
  it('creates one sender and subject notification without message text for up to three threads', () => {
    expect(
      planNotifications([mail('one'), mail('two'), mail('three')], {
        focused: false,
        now: 1_000
      })
    ).toEqual([
      {
        threadId: 'one',
        title: 'Sender one · Subject one',
        body: ''
      },
      {
        threadId: 'two',
        title: 'Sender two · Subject two',
        body: ''
      },
      {
        threadId: 'three',
        title: 'Sender three · Subject three',
        body: ''
      }
    ])
  })

  it('summarizes more than three new conversations', () => {
    expect(
      planNotifications([mail('one'), mail('two'), mail('three'), mail('four')], { focused: false })
    ).toEqual([{ title: 'Attn', body: '4 new conversations' }])
  })

  it('falls back to placeholders when a message has no sender or subject', () => {
    expect(planNotifications([mail('one', { sender: '', subject: '' })], { focused: false })).toEqual([
      { threadId: 'one', title: 'New message · (no subject)', body: '' }
    ])
  })

  it('suppresses notifications while focused or paused', () => {
    expect(planNotifications([mail('one')], { focused: true })).toEqual([])
    expect(planNotifications([mail('one')], { focused: false, pausedUntil: 1_001, now: 1_000 })).toEqual([])
    expect(planNotifications([mail('one')], { focused: false, pausedUntil: 1_000, now: 1_000 })).toHaveLength(
      1
    )
  })

  it('names the owning account in detail and summary titles when a label is given', () => {
    // With several accounts signed in, the title answers "which inbox?" before
    // the click switches there (F12/F18); with one account it stays quiet.
    expect(planNotifications([mail('one')], { focused: false, accountLabel: 'b@attn.test' })).toEqual([
      { threadId: 'one', title: 'Sender one · Subject one · b@attn.test', body: '' }
    ])
    expect(
      planNotifications([mail('one'), mail('two'), mail('three'), mail('four')], {
        focused: false,
        accountLabel: 'b@attn.test'
      })
    ).toEqual([{ title: 'Attn · b@attn.test', body: '4 new conversations' }])
    expect(planNotifications([mail('one')], { focused: false, accountLabel: null })).toEqual([
      { threadId: 'one', title: 'Sender one · Subject one', body: '' }
    ])
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
      setWindowsOverlay: (count: number, description: string): void => {
        calls.push(`windows:${count}:${description}`)
      }
    }

    applyUnreadBadge('linux', 4, true, effects)
    expect(calls).toEqual([])
    applyUnreadBadge('darwin', 4, true, effects)
    applyUnreadBadge('darwin', 4, false, effects)
    applyUnreadBadge('win32', 4, true, effects)
    applyUnreadBadge('win32', 4, false, effects)
    applyUnreadBadge('win32', 0, true, effects)
    applyUnreadBadgeToWindow('linux', 7, true, effects.setWindowsOverlay)
    applyUnreadBadgeToWindow('win32', 7, true, effects.setWindowsOverlay)
    // The visible badge caps at 9+; its accessible description keeps the exact count.
    applyUnreadBadgeToWindow('win32', 150, true, effects.setWindowsOverlay)
    applyUnreadBadgeToWindow('win32', 150, false, effects.setWindowsOverlay)
    expect(calls).toEqual([
      'mac:4',
      'mac:0',
      'windows:4:4 unread conversations',
      'windows:0:',
      'windows:0:',
      'windows:7:7 unread conversations',
      'windows:150:150 unread conversations',
      'windows:0:'
    ])
  })
})

describe('takePendingFocus', () => {
  const pending = { accountId: 'a@attn.test', threadId: 't-budget', at: 1_000 }

  it('honours a fresh target and drops one nothing picked up in time', () => {
    expect(takePendingFocus(null, 'a@attn.test')).toBeNull()
    expect(takePendingFocus(pending, 'a@attn.test', 1_000 + PENDING_FOCUS_TTL_MS)).toEqual({
      kind: 'focus',
      accountId: 'a@attn.test',
      threadId: 't-budget',
      id: 1_000
    })
    expect(takePendingFocus(pending, 'a@attn.test', 1_001 + PENDING_FOCUS_TTL_MS)).toBeNull()
  })

  it('asks for an account switch while the target names an inactive account', () => {
    // The click routes through the renderer's guarded switch (F18); the target
    // stays pending until the remounted tree for the right account pulls it.
    expect(takePendingFocus(pending, 'b@attn.test', 1_500)).toEqual({
      kind: 'switch',
      accountId: 'a@attn.test'
    })
    expect(takePendingFocus(pending, null, 1_500)).toEqual({ kind: 'switch', accountId: 'a@attn.test' })
    // Even a switch ask expires: an unconsumed click must not redirect later.
    expect(takePendingFocus(pending, 'b@attn.test', 1_001 + PENDING_FOCUS_TTL_MS)).toBeNull()
  })

  it('resolves a summary click to the inbox of its account', () => {
    expect(takePendingFocus({ accountId: 'a@attn.test', at: 1_000 }, 'a@attn.test', 1_500)).toEqual({
      kind: 'focus',
      accountId: 'a@attn.test',
      threadId: null,
      id: 1_000
    })
  })

  it('resolving is read-only: an undelivered pull cannot lose the click', () => {
    // The T32 regression: a pull whose delivery died in a torn-down
    // subscription (account remount, effect cleanup) used to consume the
    // target. Resolving now leaves it pending, so the next live tree for the
    // right account pulls the identical target again.
    const first = takePendingFocus(pending, 'a@attn.test', 1_500)
    const second = takePendingFocus(pending, 'a@attn.test', 1_600)
    expect(first).toEqual(second)
    expect(first?.kind).toBe('focus')
  })

  it('acknowledgement clears exactly the accepted target', () => {
    // Only the tree that accepted the click clears it, keyed by target id —
    // a late acknowledgement from a superseded click leaves a newer one alone.
    expect(acknowledgePendingFocus(pending, 1_000)).toBeNull()
    expect(acknowledgePendingFocus(pending, 999)).toBe(pending)
    expect(acknowledgePendingFocus(null, 1_000)).toBeNull()
  })
})

describe('candidatesFor', () => {
  it('excludes mail with no stored message from both the detail list and the count', () => {
    const db = mailDb([
      { messageId: 'message-one', threadId: 'one' },
      { messageId: 'message-two', threadId: 'two' },
      { messageId: 'message-three', threadId: 'three' }
    ])
    // Four new threads arrive, but 'four' has no persisted message row. Counting
    // it would tip the batch over the threshold and summarize instead of listing.
    const candidates = candidatesFor(db, 'user@attn.test', [
      { threadId: 'one', messageId: 'message-one' },
      // A second message on a thread already in this cycle collapses here —
      // `planNotifications` counts what this returns, one entry per thread.
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
    const db = mailDb(stored)

    // Guards the coupling between the two SUMMARY_THRESHOLD uses: hydration is
    // skipped here, so a threshold raised only in planNotifications would plan
    // detail notifications from blank rows.
    expect(planNotifications(candidatesFor(db, 'user@attn.test', stored), { focused: false })).toEqual([
      { title: 'Attn', body: '4 new conversations' }
    ])
  })

  it('filters muted splits before deciding whether to summarize', () => {
    const stored = ['eligible', 'muted-one', 'muted-two', 'muted-three'].map((threadId) => ({
      messageId: `message-${threadId}`,
      threadId,
      important: threadId === 'eligible'
    }))
    const db = mailDb(stored)

    expect(planNotifications(candidatesFor(db, 'user@attn.test', stored), { focused: false })).toEqual([
      {
        threadId: 'eligible',
        title: 'Sender eligible · Subject eligible',
        body: ''
      }
    ])
  })
})

function mailDb(inboxMessages: readonly { messageId: string; threadId: string; important?: boolean }[]): Db {
  const db = openDatabase(':memory:')
  db.prepare("INSERT INTO accounts (id, email) VALUES ('user@attn.test', 'user@attn.test')").run()
  const insertThread = db.prepare(
    `INSERT INTO threads
     (account_id, id, subject, snippet, last_msg_at, from_display, is_unread, is_inbox_visible)
     VALUES ('user@attn.test', ?, ?, ?, 1, ?, 1, 1)`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages
     (account_id, id, thread_id, from_name, from_email, snippet, labels_json, attachments_json)
     VALUES ('user@attn.test', ?, ?, ?, ?, ?, ?, '[]')`
  )
  const insertInbox = db.prepare(
    `INSERT INTO thread_labels (account_id, thread_id, label_id)
     VALUES ('user@attn.test', ?, 'INBOX')`
  )
  for (const message of inboxMessages) {
    const important = message.important !== false
    insertThread.run(
      message.threadId,
      `Subject ${message.threadId}`,
      `Snippet ${message.threadId}`,
      `Sender ${message.threadId}`
    )
    insertMessage.run(
      message.messageId,
      message.threadId,
      `Sender ${message.threadId}`,
      `sender-${message.threadId}@example.com`,
      `Snippet ${message.threadId}`,
      JSON.stringify(important ? ['IMPORTANT'] : [])
    )
    insertInbox.run(message.threadId)
  }
  return db
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
    expect(retainer.release(banner)).toBe(true)
  })

  it('releases a notification once its click has been handled', () => {
    const retainer = new BoundedRetainer<object>(50)
    const first = { id: 'first' }
    const second = { id: 'second' }
    retainer.retain(first)
    retainer.retain(second)
    expect(retainer.release(first)).toBe(true)
    // Releasing something never retained (or released twice) is a no-op, not a throw.
    expect(retainer.release(first)).toBe(false)
    expect(retainer.release(second)).toBe(true)
  })

  it('evicts the oldest beyond the cap rather than growing without bound', () => {
    const retainer = new BoundedRetainer<number>(3)
    for (const value of [1, 2, 3, 4, 5]) retainer.retain(value)
    // The evicted entries are the oldest, which are the least likely to be clicked.
    expect([1, 2].map((value) => retainer.release(value))).toEqual([false, false])
    expect([3, 4, 5].map((value) => retainer.release(value))).toEqual([true, true, true])
  })

  it('drops every reference when the notifier stops', () => {
    const retainer = new BoundedRetainer<object>(50)
    const banner = {}
    retainer.retain(banner)
    retainer.retain({})
    retainer.clear()
    expect(retainer.release(banner)).toBe(false)
  })
})

describe('notificationClickTarget', () => {
  it('routes the click while the notifying account is still on the roster', () => {
    expect(notificationClickTarget('a@attn.test', 't-budget', ['a@attn.test', 'b@attn.test'])).toEqual({
      accountId: 'a@attn.test',
      threadId: 't-budget'
    })
    // An inactive account is still a valid target — the click switches to it.
    expect(notificationClickTarget('b@attn.test', 't-beta', ['a@attn.test', 'b@attn.test'])).toEqual({
      accountId: 'b@attn.test',
      threadId: 't-beta'
    })
  })

  it('drops a target whose account was removed from under the banner', () => {
    // A banner can sit in Notification Center across a remove/re-add. Honouring
    // it would hunt a thread no signed-in account has.
    expect(notificationClickTarget('a@attn.test', 't-budget', ['b@attn.test'])).toBeNull()
    expect(notificationClickTarget('a@attn.test', 't-budget', [])).toBeNull()
  })

  it('aims a summary click at the account inbox rather than a thread', () => {
    expect(notificationClickTarget('a@attn.test', undefined, ['a@attn.test'])).toEqual({
      accountId: 'a@attn.test',
      threadId: null
    })
  })
})
