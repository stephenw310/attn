/**
 * `Mod` is Cmd on macOS and Ctrl on Windows (SPEC §3 modifier convention). Key
 * handlers already accept either modifier; this only decides what the UI shows.
 * The preload bridge exposes the platform; under unit tests it is absent.
 */
export function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.attn?.platform === 'darwin'
}

/** Display label for the platform command modifier: `⌘` on macOS, `Ctrl` elsewhere. */
export function modKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}

/**
 * One key of a shortcut as the UI shows it: the platform modifier, `Esc` for
 * Escape, and single letters upper-cased so `j` reads as `J`.
 */
export function formatShortcutKey(key: string): string {
  const lowered = key.toLowerCase()
  if (lowered === 'mod') return modKeyLabel()
  if (lowered === 'escape') return 'Esc'
  if (lowered === 'enter') return '↵'
  if (lowered === 'shift') return '⇧'
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * A whole shortcut as the UI shows it — `Mod+Shift+k` becomes `⌘⇧K`, and
 * a chord keeps its space (`g i` becomes `G I`). The footer renders each key in
 * its own Kbd and uses `formatShortcutKey` directly instead.
 */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split(' ')
    .map((keystroke) => keystroke.split('+').map(formatShortcutKey).join(''))
    .join(' ')
}
