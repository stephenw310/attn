import { describe, expect, it } from 'vitest'
import type { NotificationCandidate } from './notify'
import { planNotifications, tomorrowStart } from './notify'

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
