import { describe, expect, it } from 'vitest'
import { parseSearchQuery, searchMatchExpression } from './searchQuery'

describe('parseSearchQuery', () => {
  it.each([
    ['from:acme.com', { terms: [{ field: 'from', value: 'acme.com', quoted: false }], filters: [] }],
    [
      'to:alex subject:budget',
      {
        terms: [
          { field: 'to', value: 'alex', quoted: false },
          { field: 'subject', value: 'budget', quoted: false }
        ],
        filters: []
      }
    ],
    ['in:"Project Alpha"', { terms: [], filters: [{ kind: 'in', value: 'Project Alpha' }] }],
    [
      'is:unread is:starred is:snoozed',
      {
        terms: [],
        filters: [
          { kind: 'is', value: 'unread' },
          { kind: 'is', value: 'starred' },
          { kind: 'is', value: 'snoozed' }
        ]
      }
    ],
    ['has:attachment', { terms: [], filters: [{ kind: 'has', value: 'attachment' }] }],
    [
      'before:2026-02-01 after:2026-01-01',
      {
        terms: [],
        filters: [
          { kind: 'before', value: '2026-02-01' },
          { kind: 'after', value: '2026-01-01' }
        ]
      }
    ],
    [
      '"quarterly budget"',
      {
        terms: [{ field: 'any', value: 'quarterly budget', quoted: true }],
        filters: []
      }
    ],
    ['', { terms: [], filters: [] }]
  ])('parses %j', (query, expected) => {
    expect(parseSearchQuery(query)).toEqual(expected)
  })

  it('combines operators and literal text', () => {
    expect(parseSearchQuery('from:acme.com has:attachment after:2026-01-01 roadmap')).toEqual({
      terms: [
        { field: 'from', value: 'acme.com', quoted: false },
        { field: 'any', value: 'roadmap', quoted: false }
      ],
      filters: [
        { kind: 'has', value: 'attachment' },
        { kind: 'after', value: '2026-01-01' }
      ]
    })
  })

  it('treats unsupported and invalid operators as literal text', () => {
    expect(parseSearchQuery('re: budget is:read has:image before:2026-02-31')).toEqual({
      terms: [
        { field: 'any', value: 're:', quoted: false },
        { field: 'any', value: 'budget', quoted: false },
        { field: 'any', value: 'is:read', quoted: false },
        { field: 'any', value: 'has:image', quoted: false },
        { field: 'any', value: 'before:2026-02-31', quoted: false }
      ],
      filters: []
    })
  })
})

describe('searchMatchExpression', () => {
  it('uses column filters, phrases, prefix terms, and escaped quotes', () => {
    expect(searchMatchExpression(parseSearchQuery('from:acme.com subject:"annual "plan"" roadmap'))).toBe(
      'sender : "acme.com"* AND subject : "annual plan" AND "roadmap"*'
    )
  })

  it('returns null for a filter-only query', () => {
    expect(searchMatchExpression(parseSearchQuery('is:unread'))).toBeNull()
  })
})
