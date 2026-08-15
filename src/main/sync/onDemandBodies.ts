import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { hydrateMissingThreadBodies } from './bodies'
import { persistThread } from './persist'
import type { MailProvider } from './provider'

export interface HydrationEffects {
  persist: (db: Db, accountId: string, thread: GmailThread) => void
  hydrateMissing: (db: Db, provider: MailProvider, accountId: string, thread: GmailThread) => Promise<void>
}

const productionEffects: HydrationEffects = {
  persist: persistThread,
  hydrateMissing: hydrateMissingThreadBodies
}

/** Account-scoped single-flight coordinator for on-demand full-body fetches. */
export class OnDemandBodyHydrator {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly db: Db,
    private readonly currentAccountId: () => string | null,
    private readonly onChanged: () => void,
    private readonly onFailed: (accountId: string, threadId: string, error: unknown) => void,
    private readonly effects: HydrationEffects = productionEffects
  ) {}

  request(accountId: string, threadId: string, provider: MailProvider): Promise<void> {
    const key = `${accountId}\0${threadId}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const attempt = this.run(accountId, threadId, provider).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, attempt)
    return attempt
  }

  private async run(accountId: string, threadId: string, provider: MailProvider): Promise<void> {
    try {
      if (this.currentAccountId() !== accountId) return
      const thread = await provider.getThread(threadId, { format: 'full' })
      if (this.currentAccountId() !== accountId) return
      this.effects.persist(this.db, accountId, thread)
      await this.effects.hydrateMissing(this.db, provider, accountId, thread)
      if (this.currentAccountId() === accountId) this.onChanged()
    } catch (error) {
      if (this.currentAccountId() === accountId) this.onFailed(accountId, threadId, error)
    }
  }
}
