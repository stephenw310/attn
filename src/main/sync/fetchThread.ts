import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { type PersistThreadOptions, persistThread } from './persist'
import type { GetThreadOptions, MailProvider } from './provider'

export type ThreadFetchProvider = Pick<MailProvider, 'getThread'>

export interface FetchAndCacheThreadOptions extends GetThreadOptions {
  persistOptions?: PersistThreadOptions
  shouldPersist?: () => boolean
}

/** Fetch one authoritative Gmail thread snapshot and cache it through persistThread. */
export async function fetchAndCacheThread(
  db: Db,
  accountId: string,
  provider: ThreadFetchProvider,
  threadId: string,
  options: FetchAndCacheThreadOptions = {}
): Promise<GmailThread> {
  const format = options.format ?? 'full'
  const thread = await provider.getThread(threadId, {
    format,
    priority: options.priority ?? 'foreground',
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (options.shouldPersist && !options.shouldPersist()) return thread
  persistThread(db, accountId, thread, {
    ...options.persistOptions,
    ...(format === 'metadata' ? { metadataOnly: true } : {})
  })
  return thread
}
