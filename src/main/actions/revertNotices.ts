import type { RevertedAction } from '../../shared/actionRevert'

/**
 * Keeps failed-action notices until the active account's renderer consumes
 * them. A broadcast alone is lossy while Electron is still mounting a window.
 */
export class ActionRevertNotices {
  private readonly pending = new Map<string, RevertedAction[]>()

  add(accountId: string, actions: readonly RevertedAction[]): void {
    if (actions.length === 0) return
    const existing = this.pending.get(accountId) ?? []
    this.pending.set(accountId, [...existing, ...actions])
  }

  take(accountId: string): RevertedAction[] {
    const actions = this.pending.get(accountId) ?? []
    this.pending.delete(accountId)
    return actions
  }

  clear(accountId?: string): void {
    if (accountId) this.pending.delete(accountId)
    else this.pending.clear()
  }
}
