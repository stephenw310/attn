import { describe, expect, it } from 'vitest'
import { parseSearchQuery } from '../../shared/searchQuery'
import { toGmailSearchQuery } from './searchQuery'

describe('toGmailSearchQuery', () => {
  it.each([
    [
      'from:acme.com has:attachment after:2026-01-01',
      { q: 'from:acme.com has:attachment after:2026/01/01 -in:drafts', includeSpamTrash: false }
    ],
    [
      'to:alex subject:"quarterly budget" is:unread is:starred',
      {
        q: 'to:alex subject:"quarterly budget" is:unread is:starred -in:drafts',
        includeSpamTrash: false
      }
    ],
    [
      'in:all-mail before:2026-02-01',
      {
        q: 'in:anywhere -in:spam -in:trash before:2026/02/01 -in:drafts',
        includeSpamTrash: false
      }
    ],
    ['in:trash', { q: 'in:trash -in:drafts', includeSpamTrash: true }],
    ['in:drafts subject:budget', { q: 'subject:budget in:drafts', includeSpamTrash: false }],
    ['re: budget', { q: '"re:" budget -in:drafts', includeSpamTrash: false }]
  ])('translates %j', (query, expected) => {
    expect(toGmailSearchQuery(parseSearchQuery(query))).toEqual(expected)
  })

  it('resolves a local label id to its Gmail label name', () => {
    expect(
      toGmailSearchQuery(parseSearchQuery('in:Label_Project'), {
        resolveLabelName: (value) => (value === 'Label_Project' ? 'Project Alpha' : value)
      })
    ).toEqual({ q: 'label:"Project Alpha" -in:drafts', includeSpamTrash: false })
  })
})
