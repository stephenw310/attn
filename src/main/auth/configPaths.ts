import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Resolve the primary checkout for a linked Git worktree. Development OAuth
 * config is intentionally untracked, so it commonly exists only there.
 */
export function linkedCheckoutRoot(appPath: string): string | null {
  try {
    const marker = readFileSync(join(appPath, '.git'), 'utf8').trim()
    if (!marker.startsWith('gitdir:')) return null
    const gitDir = resolve(appPath, marker.slice('gitdir:'.length).trim())
    const worktreesDir = dirname(gitDir)
    if (worktreesDir.split(/[\\/]/).at(-1) !== 'worktrees') return null
    return dirname(dirname(worktreesDir))
  } catch {
    return null
  }
}

export function oauthConfigSearchDirs(appPath: string, userData: string, isolatedTest: boolean): string[] {
  if (isolatedTest) return [userData]
  const linkedRoot = linkedCheckoutRoot(appPath)
  return [...new Set([appPath, linkedRoot, userData].filter((path): path is string => path !== null))]
}
