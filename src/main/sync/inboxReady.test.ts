import { describe, expect, it } from 'vitest'
import { inboxBackfillReady } from './inboxReady'

describe('inboxBackfillReady', () => {
  it('waits for the Inbox full-body walk to finish', () => {
    expect(inboxBackfillReady(undefined, 'done')).toBe(false)
    expect(inboxBackfillReady(null, 'done')).toBe(false)
    expect(inboxBackfillReady('', 'done')).toBe(false)
    expect(inboxBackfillReady('metadata', 'done')).toBe(false)
    expect(inboxBackfillReady('metadata:page-2', 'done')).toBe(false)
    expect(inboxBackfillReady('bodies', 'done')).toBe(false)
    expect(inboxBackfillReady('bodies:page-2', 'done')).toBe(false)
    expect(inboxBackfillReady('unknown', 'done')).toBe(false)
  })

  it('waits for an upgraded profile to rebuild split metadata', () => {
    expect(inboxBackfillReady('done', undefined)).toBe(false)
    expect(inboxBackfillReady('done', null)).toBe(false)
    expect(inboxBackfillReady('done', 'split-metadata')).toBe(false)
    expect(inboxBackfillReady('done', 'split-metadata:page-2')).toBe(false)
  })

  it('accepts every checkpoint after Inbox bodies when split metadata is complete', () => {
    for (const cursor of [
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
      expect(inboxBackfillReady(cursor, 'done')).toBe(true)
    }
  })
})
