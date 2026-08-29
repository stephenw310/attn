import { describe, expect, it } from 'vitest'
import { inboxBackfillReady } from './inboxReady'

describe('inboxBackfillReady', () => {
  it('waits for the Inbox metadata walk to checkpoint its next stage', () => {
    expect(inboxBackfillReady(undefined)).toBe(false)
    expect(inboxBackfillReady(null)).toBe(false)
    expect(inboxBackfillReady('')).toBe(false)
    expect(inboxBackfillReady('metadata')).toBe(false)
    expect(inboxBackfillReady('metadata:page-2')).toBe(false)
    expect(inboxBackfillReady('unknown')).toBe(false)
  })

  it('accepts every checkpoint after Inbox metadata', () => {
    for (const cursor of [
      'bodies',
      'bodies:page-2',
      'drafts',
      'drafts:page-2',
      'all-mail',
      'all-mail:page-3',
      'spam',
      'spam:page-1',
      'trash',
      'trash:page-1',
      'sent',
      'sent:legacy-page',
      'reconcile',
      'done'
    ]) {
      expect(inboxBackfillReady(cursor)).toBe(true)
    }
  })
})
