import { describe, expect, it } from 'vitest'
import type { MailLabel, SnoozedThreadRow, ThreadRow } from '../../shared/mail'
import { reuseLabels, reuseSnoozedRows, reuseThreadRows } from './mailDataEquality'

const row = (overrides: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'thread-1',
  fromDisplay: 'Maya',
  subject: 'Roadmap',
  snippet: 'The latest plan',
  lastMsgAt: 1,
  unread: false,
  starred: false,
  hasAttachment: false,
  returned: false,
  hasDraft: false,
  labelIds: ['INBOX'],
  ...overrides
})

describe('mail data identity reuse', () => {
  it('keeps thread-list identity when an IPC refresh returns the same rows', () => {
    const current = [row()]
    const equivalent = [row({ labelIds: ['INBOX'] })]

    expect(reuseThreadRows(current, equivalent)).toBe(current)
    expect(reuseThreadRows(current, [row({ unread: true })])).not.toBe(current)
  })

  it('includes snooze deadlines and labels in the equality check', () => {
    const currentSnoozed: SnoozedThreadRow[] = [{ ...row(), dueAt: 10 }]
    expect(reuseSnoozedRows(currentSnoozed, [{ ...row(), dueAt: 10 }])).toBe(currentSnoozed)
    expect(reuseSnoozedRows(currentSnoozed, [{ ...row(), dueAt: 11 }])).not.toBe(currentSnoozed)

    const currentLabels: MailLabel[] = [{ id: 'Label_1', name: 'Projects', type: 'user' }]
    expect(reuseLabels(currentLabels, [{ id: 'Label_1', name: 'Projects', type: 'user' }])).toBe(
      currentLabels
    )
    expect(reuseLabels(currentLabels, [{ id: 'Label_1', name: 'Work', type: 'user' }])).not.toBe(
      currentLabels
    )
  })
})
