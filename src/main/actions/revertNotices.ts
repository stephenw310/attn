import type { ActionRevertNotice, RevertedAction } from '../../shared/actionRevert'

/**
 * Keeps failed-action notices until the active account's renderer consumes
 * them. A broadcast alone is lossy while Electron is still mounting a window.
 */
export class ActionRevertNotices {
  private readonly pending = new Map<string, ActionRevertNotice[]>()
  private nextId = 1

  add(accountId: string, actions: readonly RevertedAction[]): void {
    if (actions.length === 0) return
    const existing = this.pending.get(accountId) ?? []
    this.pending.set(accountId, [...existing, { id: this.nextId++, actions: [...actions] }])
  }

  peek(accountId: string): ActionRevertNotice | null {
    return this.pending.get(accountId)?.[0] ?? null
  }

  acknowledge(accountId: string, noticeId: number): boolean {
    const notices = this.pending.get(accountId)
    if (!notices || notices[0]?.id !== noticeId) return false
    notices.shift()
    if (notices.length === 0) this.pending.delete(accountId)
    return true
  }

  clear(accountId?: string): void {
    if (accountId) this.pending.delete(accountId)
    else this.pending.clear()
  }
}
