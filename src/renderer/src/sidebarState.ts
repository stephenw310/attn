export const SIDEBAR_COLLAPSED_KEY = 'attn.sidebarCollapsed'

interface SidebarStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Reading `localStorage` itself throws when site data is blocked. */
function browserStorage(): SidebarStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readSidebarCollapsed(storage: SidebarStorage | null = browserStorage()): boolean {
  if (!storage) return false
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage: SidebarStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  } catch {
    // A blocked storage write should not make the navigation unusable.
  }
}
