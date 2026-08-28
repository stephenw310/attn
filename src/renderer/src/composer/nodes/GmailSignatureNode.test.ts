// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { collapseGmailSignature, revealGmailSignature } from './GmailSignatureNode'

describe('Gmail signature composer presentation', () => {
  it('collapses as an accessible one-way reveal without changing its content', () => {
    const signature = document.createElement('div')
    signature.innerHTML = '<div>Best,</div><div>Chao Wu</div>'

    collapseGmailSignature(signature)

    expect(signature.dataset.attnSignatureCollapsed).toBe('true')
    expect(signature.getAttribute('contenteditable')).toBe('false')
    expect(signature.getAttribute('role')).toBe('button')
    expect(signature.getAttribute('tabindex')).toBe('0')
    expect(signature.getAttribute('aria-label')).toBe('Show signature')
    expect(signature.textContent).toBe('Best,Chao Wu')

    revealGmailSignature(signature)

    expect(signature.dataset.attnSignatureCollapsed).toBeUndefined()
    expect(signature.hasAttribute('contenteditable')).toBe(false)
    expect(signature.hasAttribute('role')).toBe(false)
    expect(signature.hasAttribute('tabindex')).toBe(false)
    expect(signature.hasAttribute('aria-label')).toBe(false)
    expect(signature.textContent).toBe('Best,Chao Wu')
  })
})
