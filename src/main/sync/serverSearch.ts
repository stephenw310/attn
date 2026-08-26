import type { ThreadRow } from '../../shared/mail'
import type { ServerSearchResponse } from '../../shared/searchQuery'
import { parseSearchQuery } from '../../shared/searchQuery'
import type { Db } from '../db'
import { SEARCH_RESULT_LIMIT, searchRowsByThreadIds, searchThreads } from '../db/search'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import { toGmailSearchQuery } from '../gmail/searchQuery'
import { hydrateMissingThreadBodies } from './bodies'
import { isOfflineFailure } from './failure'
import { fetchAndCacheThread } from './fetchThread'
import type { MailProvider } from './provider'

export type ServerSearchProvider = Pick<
  MailProvider,
  'listThreadIds' | 'getThread' | 'getAttachmentData' | 'quotaMetrics'
>

export interface SearchAllGmailResult {
  rows: ThreadRow[]
  quotaWaitMs: number
}

export interface SearchAllGmailOptions {
  shouldContinue?: () => boolean
  signal?: AbortSignal
}

/** Keep Gmail order, remove repeated ids, and leave existing local results in their original section. */
export function newServerThreadIds(
  localThreadIds: Iterable<string>,
  serverThreadIds: Iterable<string>
): string[] {
  const local = new Set(localThreadIds)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const threadId of serverThreadIds) {
    if (!threadId || local.has(threadId) || seen.has(threadId)) continue
    seen.add(threadId)
    merged.push(threadId)
    if (merged.length >= SEARCH_RESULT_LIMIT) break
  }
  return merged
}

function labelResolver(db: Db, accountId: string): (value: string) => string {
  const labels = db.prepare('SELECT id, name FROM labels WHERE account_id = ?').all(accountId) as Array<{
    id: string
    name: string
  }>
  const names = new Map<string, string>()
  for (const label of labels) {
    names.set(label.id.toLocaleLowerCase(), label.name)
    names.set(label.name.toLocaleLowerCase(), label.name)
  }
  return (value) => names.get(value.toLocaleLowerCase()) ?? value
}

export async function searchAllGmail(
  db: Db,
  accountId: string,
  provider: ServerSearchProvider,
  query: string,
  options: SearchAllGmailOptions = {}
): Promise<SearchAllGmailResult> {
  const shouldContinue = (): boolean => !options.signal?.aborted && (options.shouldContinue?.() ?? true)
  const parsed = parseSearchQuery(query)
  const searchesLocalSnoozes = parsed.filters.some(
    (filter) =>
      (filter.kind === 'is' && filter.value === 'snoozed') ||
      (filter.kind === 'in' && filter.value.toLowerCase().replaceAll(/[\s_-]/g, '') === 'snoozed')
  )
  if (searchesLocalSnoozes) return { rows: [], quotaWaitMs: 0 }
  const gmailQuery = toGmailSearchQuery(parsed, { resolveLabelName: labelResolver(db, accountId) })
  const localIds = searchThreads(db, accountId, query).rows.map((row) => row.id)
  const waitStartedAt = provider.quotaMetrics?.().waitMs ?? 0
  const excludedIds = new Set(localIds)
  const storedIds: string[] = []
  let pageToken: string | undefined
  do {
    if (!shouldContinue()) return { rows: [], quotaWaitMs: 0 }
    const page = await provider.listThreadIds({
      q: gmailQuery.q,
      includeSpamTrash: gmailQuery.includeSpamTrash,
      ...(options.signal ? { signal: options.signal } : {}),
      priority: 'foreground',
      ...(pageToken ? { pageToken } : {})
    })
    if (!shouldContinue()) return { rows: [], quotaWaitMs: 0 }
    const candidateIds = newServerThreadIds(excludedIds, page.threadIds)
    for (const threadId of candidateIds) {
      excludedIds.add(threadId)
      try {
        const thread = await fetchAndCacheThread(db, accountId, provider, threadId, {
          format: 'full',
          priority: 'foreground',
          ...(options.signal ? { signal: options.signal } : {}),
          shouldPersist: shouldContinue
        })
        if (!shouldContinue()) return { rows: [], quotaWaitMs: 0 }
        await hydrateMissingThreadBodies(db, provider, accountId, thread, shouldContinue, {
          ...(options.signal ? { signal: options.signal } : {}),
          priority: 'foreground'
        })
        if (!shouldContinue()) return { rows: [], quotaWaitMs: 0 }
        storedIds.push(threadId)
        if (storedIds.length >= SEARCH_RESULT_LIMIT) break
      } catch (error) {
        // A list result can disappear before the follow-up get. It is not a
        // failed search and must not hide the surviving results.
        if (error instanceof GmailApiError && error.status === 404) continue
        throw error
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken && storedIds.length < SEARCH_RESULT_LIMIT)
  return {
    rows: searchRowsByThreadIds(db, accountId, storedIds, query),
    quotaWaitMs: Math.max(0, (provider.quotaMetrics?.().waitMs ?? waitStartedAt) - waitStartedAt)
  }
}

export function serverSearchFailure(error: unknown): Exclude<ServerSearchResponse, { status: 'ok' }> {
  if (error instanceof GmailAuthError || (error instanceof GmailApiError && error.status === 401)) {
    return { status: 'auth-required', message: 'Google authorization expired' }
  }
  if (isOfflineFailure(error)) {
    return { status: 'offline', message: 'Search Gmail when you are back online' }
  }
  if (error instanceof GmailApiError && error.retryable) {
    return { status: 'error', message: 'Gmail is busy. Try the search again.' }
  }
  return { status: 'error', message: 'Gmail search could not be completed' }
}
