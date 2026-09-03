import { describe, expect, it } from 'vitest'
import {
  conversationMailboxForSearch,
  searchAllowsMove,
  searchesDrafts,
  searchesLocalSnoozes,
  searchRetainsMovedThread,
  triageViewForSearch
} from './searchView'

describe('search result interpretation', () => {
  it('reads the last completed query, which Inbox keeps showing while a new one is typed', () => {
    const query = 'in:trash subject:invoice'

    expect(searchesDrafts(query)).toBe(false)
    expect(conversationMailboxForSearch(query)).toBe('trash')
    expect(triageViewForSearch(query)).toBe('allMail')
  })

  it('reads the typed query, which stands in before the first response completes', () => {
    const query = 'in:drafts subject:quarterly'

    expect(searchesDrafts(query)).toBe(true)
    expect(conversationMailboxForSearch(query)).toBe('normal')
  })

  it('treats an Inbox search as an Inbox triage list', () => {
    expect(triageViewForSearch('from:acme in:inbox')).toBe('inbox')
  })

  it.each(['is:snoozed', 'in:snoozed'])('identifies %s as a local-only snooze search', (query) => {
    expect(searchesLocalSnoozes(query)).toBe(true)
  })

  it('allows Move for Spam and Trash searches but not non-mail destinations', () => {
    expect(searchAllowsMove('from:maya in:inbox')).toBe(true)
    expect(searchAllowsMove('in:starred subject:roadmap')).toBe(true)
    expect(searchAllowsMove('in:"Project Alpha"')).toBe(true)
    expect(searchAllowsMove('in:spam')).toBe(true)
    expect(searchAllowsMove('in:trash')).toBe(true)
    for (const query of ['in:drafts', 'is:snoozed', 'in:snoozed', 'in:outbox']) {
      expect(searchAllowsMove(query)).toBe(false)
    }
  })

  it('re-evaluates Move against the completed search filters', () => {
    const moved = {
      hasAttachment: true,
      labelIds: ['STARRED', 'project-alpha'],
      snoozed: false,
      starred: true,
      unread: true
    }
    const labels = [{ id: 'project-alpha', name: 'Project Alpha', type: 'user' }]

    expect(searchRetainsMovedThread('from:maya in:inbox', moved, labels)).toBe(false)
    expect(searchRetainsMovedThread('in:starred has:attachment', moved, labels)).toBe(true)
    expect(searchRetainsMovedThread('in:"Project Alpha" is:unread', moved, labels)).toBe(true)
    expect(searchRetainsMovedThread('is:snoozed', moved, labels)).toBe(false)
  })

  it('removes junk moves from every search scope that requires normal mail', () => {
    const movedToTrash = {
      hasAttachment: false,
      labelIds: ['TRASH', 'STARRED', 'SENT', 'project-alpha'],
      snoozed: false,
      starred: true,
      unread: false
    }
    const labels = [{ id: 'project-alpha', name: 'Project Alpha', type: 'user' }]

    for (const query of [
      'subject:roadmap',
      'in:all',
      'in:all-mail',
      'in:sent',
      'in:starred',
      'in:"Project Alpha"'
    ]) {
      expect(searchRetainsMovedThread(query, movedToTrash, labels), query).toBe(false)
    }
    expect(searchRetainsMovedThread('in:trash', movedToTrash, labels)).toBe(true)
  })
})
