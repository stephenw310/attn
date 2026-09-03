import { describe, expect, it } from 'vitest'
import { cssDeclarations, isRgbColor, parsedRgbColor, splitCssDeclarations } from './css'

describe('splitCssDeclarations', () => {
  it('splits on top-level semicolons only, so values keep their own', () => {
    expect(splitCssDeclarations('background:url(data:image/gif;base64,AAA);position:fixed')).toEqual([
      'background:url(data:image/gif;base64,AAA)',
      'position:fixed'
    ])
    expect(splitCssDeclarations('font-family:"a;b";color:red')).toEqual(['font-family:"a;b"', 'color:red'])
  })

  it('keeps an escaped character with its declaration rather than ending it', () => {
    expect(splitCssDeclarations('content:"\\";x";color:red')).toEqual(['content:"\\";x"', 'color:red'])
  })

  it('never loses a nested parenthesis or an unbalanced closer', () => {
    expect(splitCssDeclarations('width:calc((1px + 2px)*3);color:red')).toEqual([
      'width:calc((1px + 2px)*3)',
      'color:red'
    ])
    expect(splitCssDeclarations('a:);b:1')).toEqual(['a:)', 'b:1'])
  })
})

describe('cssDeclarations', () => {
  it('drops fragments that are not declarations', () => {
    expect(cssDeclarations('not-a-declaration;;color:red')).toEqual([
      { property: 'color', value: 'red', raw: 'color:red' }
    ])
    expect(cssDeclarations(':red')).toEqual([])
  })

  it('normalizes the property the way a browser does before a filter reads it', () => {
    // A comment or whitespace before the colon is legal CSS, so a filter that
    // matched the raw text would miss `position` here and let it through.
    expect(cssDeclarations('POSITION /*x*/ : fixed').at(0)?.property).toBe('position')
    expect(cssDeclarations('position:fixed').at(0)?.raw).toBe('position:fixed')
  })

  it('leaves the value untouched apart from trimming', () => {
    expect(cssDeclarations('background: url(data:image/gif;base64,AAA) ').at(0)?.value).toBe(
      'url(data:image/gif;base64,AAA)'
    )
  })
})

describe('parsedRgbColor', () => {
  it('reads every serialization a browser emits', () => {
    expect(parsedRgbColor('rgb(58, 58, 60)')).toEqual({ red: 58, green: 58, blue: 60, alpha: 1 })
    expect(parsedRgbColor('rgba(255,255,255,0)')).toEqual({ red: 255, green: 255, blue: 255, alpha: 0 })
    expect(parsedRgbColor('rgb(100% 0% 50% / 50%)')).toEqual({ red: 255, green: 0, blue: 127.5, alpha: 0.5 })
  })

  it('refuses names, hex and functions it cannot resolve', () => {
    expect(parsedRgbColor('white')).toBeNull()
    expect(parsedRgbColor('#fff')).toBeNull()
    expect(parsedRgbColor('color-mix(in srgb, red, blue)')).toBeNull()
  })

  it('compares an opaque triple whatever the spacing', () => {
    expect(isRgbColor('rgb(58,58,60)', 58, 58, 60)).toBe(true)
    expect(isRgbColor('rgba(58, 58, 60, 0.5)', 58, 58, 60)).toBe(false)
    expect(isRgbColor('white', 255, 255, 255)).toBe(false)
  })
})
