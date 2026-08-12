import { describe, expect, it } from 'vitest'
import { forceLightMailCss } from './mailCss'

describe('forceLightMailCss', () => {
  it('disables dark color-scheme conditions without changing other media queries', () => {
    const css = `
      @media (prefers-color-scheme: dark) { .copy { color: white; } }
      @media(PREFERS-COLOR-SCHEME:DARK), (max-width: 600px) { .stack { display: block; } }
      @media (prefers-color-scheme: light) { .copy { color: black; } }
    `

    const result = forceLightMailCss(css)

    expect(result).not.toMatch(/prefers-color-scheme\s*:\s*dark/i)
    expect(result).toContain('(prefers-color-scheme: attn-disabled-dark)')
    expect(result).toContain('(PREFERS-COLOR-SCHEME:attn-disabled-dark), (max-width: 600px)')
    expect(result).toContain('(prefers-color-scheme: light)')
  })

  it('does not alter color declarations or prose mentioning dark mode', () => {
    const css = '.copy { color: darkblue; } /* prefers-color-scheme: dark */'

    expect(forceLightMailCss(css)).toBe(css)
  })
})
