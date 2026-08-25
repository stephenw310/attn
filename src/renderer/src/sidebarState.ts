export const SIDEBAR_COLLAPSED_KEY = 'attn.sidebarCollapsed'

interface SidebarStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readSidebarCollapsed(storage: SidebarStorage | null): boolean {
  if (!storage) return false
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(storage: SidebarStorage | null, collapsed: boolean): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  } catch {
    // A blocked storage write should not make the navigation unusable.
  }
}
