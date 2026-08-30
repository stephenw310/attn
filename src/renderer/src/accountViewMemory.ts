import type { MailView, NavigableMailView } from './mailDisplay'

/** Selection and scroll for one view, mirroring Inbox's ViewRecord shape. */
export interface ViewRecordSnapshot {
  rowId: string | null
  index: number
  scrollTop: number
  /** Reload this extent before applying a saved scroll offset. */
  loadedRows?: number
}

/**
 * Everything a warm account switch restores: the view on screen, the active
 * split, and every view's selection/scroll records (SPEC F18 — a switch
 * "restores that account's last view, selection, and scroll from the
 * session"). Session memory only: the mail tree remounts keyed by account,
 * so this lives above the remount boundary and dies with the renderer.
 */
export interface AccountViewSnapshot {
  view: NavigableMailView
  splitId: string | null
  viewRecords: ReadonlyArray<readonly [MailView, ViewRecordSnapshot]>
  splitRecords: ReadonlyArray<readonly [string, ViewRecordSnapshot]>
}

const memory = new Map<string, AccountViewSnapshot>()

export function saveAccountView(accountId: string, snapshot: AccountViewSnapshot): void {
  memory.set(accountId, snapshot)
}

/** Read without consuming: A→B→A→B keeps restoring until a newer save lands. */
export function readAccountView(accountId: string): AccountViewSnapshot | null {
  return memory.get(accountId) ?? null
}

/** A removed account's memory must not resurface if the address is re-added. */
export function clearAccountView(accountId: string): void {
  memory.delete(accountId)
}
