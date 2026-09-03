import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../shared/theme'

const rendererDirectory = new URL('.', import.meta.url)

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) return sourceFiles(child)
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [child] : []
  })
}

describe('theme token coverage', () => {
  it('defines a CSS value set for every built-in palette', () => {
    const css = readFileSync(new URL('app.css', rendererDirectory), 'utf8')
    for (const theme of THEME_IDS) {
      if (theme === 'dispatch-dark') continue
      expect(css).toContain(`:root[data-theme="${theme}"]`)
    }
  })

  it('keeps app chrome free of component-level color literals', () => {
    // These files serialize sender-authored mail or Google brand colors. Their
    // literals do not paint themeable Attn chrome and are covered separately.
    const interoperabilityFiles = new Set(['components/LoginScreen.tsx', 'composer/nodes/OpaqueHtmlNode.tsx'])
    const offenders = sourceFiles(rendererDirectory).flatMap((file) => {
      const relative = file.pathname.slice(rendererDirectory.pathname.length)
      if (interoperabilityFiles.has(relative)) return []
      const source = readFileSync(file, 'utf8')
      return /(?:bg|border|text)-\[#[\da-f]{3,8}\]|(?:bg|border|text)-white(?:\b|\/)|rgba?\(/i.test(source)
        ? [relative]
        : []
    })
    expect(offenders).toEqual([])
  })
})
