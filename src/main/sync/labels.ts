import type { Db } from '../db'
import { upsertLabels } from './persist'
import type { MailProvider } from './provider'

/** Refresh Gmail's label catalog without coupling the poller to SQLite details. */
export async function syncLabelCatalog(db: Db, accountId: string, provider: MailProvider): Promise<boolean> {
  return upsertLabels(db, accountId, await provider.listLabels({ priority: 'polling' }))
}
