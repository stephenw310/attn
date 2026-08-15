import { describe, expect, it } from 'vitest'
import { stripUnsafeQuoteCss } from './mailSanitizer'

describe('stripUnsafeQuoteCss', () => {
  it('removes the properties that lift quoted content out of normal flow', () => {
    expect(stripUnsafeQuoteCss('position:fixed;inset:0;background:white;z-index:9999')).toBe(
      'background:white'
    )
    expect(stripUnsafeQuoteCss('position:absolute;top:0;left:0;width:100%;height:100%')).toBe(
      'width:100%; height:100%'
    )
    expect(stripUnsafeQuoteCss('transform:translateY(-900px);color:red')).toBe('color:red')
  })

  it('keeps the formatting that makes a quote readable', () => {
    const formatting =
      'color:#333; font-weight:bold; font-family:"Helvetica Neue", Arial; border-left:2px solid #ccc; padding:8px'
    expect(stripUnsafeQuoteCss(formatting)).toBe(formatting)
  })

  it('drops negative margins by value while keeping positive ones', () => {
    expect(stripUnsafeQuoteCss('margin-top:-500px;color:blue')).toBe('color:blue')
    expect(stripUnsafeQuoteCss('margin:0 -40px')).toBe('')
    expect(stripUnsafeQuoteCss('margin:0 auto;margin-bottom:12px')).toBe('margin:0 auto; margin-bottom:12px')
  })

  it('matches vendor-prefixed forms of the same properties', () => {
    expect(stripUnsafeQuoteCss('-webkit-transform:scale(50);color:red')).toBe('color:red')
  })

  it('splits on top-level semicolons only, so values keep their own', () => {
    expect(stripUnsafeQuoteCss('background:url(data:image/gif;base64,AAA);position:fixed')).toBe(
      'background:url(data:image/gif;base64,AAA)'
    )
    expect(stripUnsafeQuoteCss('font-family:"a;b";position:fixed')).toBe('font-family:"a;b"')
  })

  it('drops the legacy CSS scripting vectors', () => {
    expect(stripUnsafeQuoteCss('behavior:url(x.htc);-moz-binding:url(y.xml);color:red')).toBe('color:red')
    expect(stripUnsafeQuoteCss('width:expression(alert(1));color:red')).toBe('color:red')
  })

  it('discards malformed fragments rather than passing them through', () => {
    expect(stripUnsafeQuoteCss('position:fixed')).toBe('')
    expect(stripUnsafeQuoteCss('not-a-declaration;;color:red')).toBe('color:red')
    expect(stripUnsafeQuoteCss('')).toBe('')
  })
})
