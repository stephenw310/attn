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
