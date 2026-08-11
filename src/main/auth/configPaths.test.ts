import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkedCheckoutRoot, oauthConfigSearchDirs } from './configPaths'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OAuth config search paths', () => {
  it('finds the primary checkout from a linked worktree marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'attn-config-paths-'))
    temporaryRoots.push(root)
    const checkout = join(root, 'checkout')
    const worktree = join(root, 'worktree')
    const gitDir = join(checkout, '.git', 'worktrees', 'feature')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)

    expect(linkedCheckoutRoot(worktree)).toBe(checkout)
    expect(oauthConfigSearchDirs(worktree, '/user-data', false)).toEqual([worktree, checkout, '/user-data'])
  })

  it('keeps isolated tests away from checkout configuration', () => {
    expect(oauthConfigSearchDirs('/app', '/isolated-user-data', true)).toEqual(['/isolated-user-data'])
  })
})
