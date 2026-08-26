import { describe, expect, it } from 'vitest'
import {
  conversationMailboxForSearch,
  retainedSearchQuery,
  searchesDrafts,
  triageViewForSearch
} from './searchView'

describe('search result interpretation', () => {
  it('uses the last completed query while a different query is pending', () => {
    const query = retainedSearchQuery('in:drafts subject:quarterly', 'in:trash subject:invoice')

    expect(searchesDrafts(query)).toBe(false)
    expect(conversationMailboxForSearch(query)).toBe('trash')
    expect(triageViewForSearch(query)).toBe('allMail')
  })

  it('uses the input query before the first response completes', () => {
    const query = retainedSearchQuery('in:drafts subject:quarterly', null)

    expect(searchesDrafts(query)).toBe(true)
    expect(conversationMailboxForSearch(query)).toBe('normal')
  })

  it('treats an Inbox search as an Inbox triage list', () => {
    expect(triageViewForSearch('from:acme in:inbox')).toBe('inbox')
  })
})
