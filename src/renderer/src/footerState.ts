export const FOOTER_COLLAPSED_KEY = 'attn.footerCollapsed'

interface FooterStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Reading `localStorage` itself throws when site data is blocked. */
function browserStorage(): FooterStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readFooterCollapsed(storage: FooterStorage | null = browserStorage()): boolean {
  if (!storage) return false
  try {
    return storage.getItem(FOOTER_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeFooterCollapsed(
  collapsed: boolean,
  storage: FooterStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(FOOTER_COLLAPSED_KEY, String(collapsed))
  } catch {
    // A blocked storage write should not make the footer unusable.
  }
}
