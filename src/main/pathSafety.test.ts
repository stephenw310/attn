import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathInside } from './pathSafety'

describe('path containment', () => {
  const root = resolve('/tmp', 'attn-outbox')

  it('accepts descendants, including names that begin with two dots', () => {
    expect(isPathInside(root, resolve(root, 'draft', 'attachment'))).toBe(true)
    expect(isPathInside(root, resolve(root, '..notes'))).toBe(true)
  })

  it('rejects the root itself, parents, and sibling-prefix paths', () => {
    expect(isPathInside(root, root)).toBe(false)
    expect(isPathInside(root, resolve(root, '..'))).toBe(false)
    expect(isPathInside(root, `${root}-other/attachment`)).toBe(false)
  })
})
