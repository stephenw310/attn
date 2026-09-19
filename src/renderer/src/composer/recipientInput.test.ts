import { describe, expect, it } from 'vitest'
import { isCompleteRecipient, shouldCommitOnComma } from './recipientInput'

describe('shouldCommitOnComma', () => {
  it('keeps a comma inside an open quoted display name', () => {
    const typed = '"Doe'
    expect(shouldCommitOnComma(typed, typed.length)).toBe(false)
    expect(shouldCommitOnComma('"Doe, John', 10)).toBe(false)
    expect(shouldCommitOnComma('Ann "Doe', 8)).toBe(false)
  })

  it('separates once the quote is closed, or where there is none', () => {
    expect(shouldCommitOnComma('a@x.test', 8)).toBe(true)
    expect(shouldCommitOnComma('"Doe, John" <j@x.test>', 22)).toBe(true)
    expect(shouldCommitOnComma('"Doe \\" John"', 13)).toBe(true)
  })

  it('reads only the text before the caret', () => {
    // Typing a comma before an already-quoted name still separates.
    expect(shouldCommitOnComma('a@x.test "Doe John"', 8)).toBe(true)
    expect(shouldCommitOnComma('"Doe John" more', 5)).toBe(false)
  })
})

describe('isCompleteRecipient', () => {
  it('recognizes text that is already one address', () => {
    expect(isCompleteRecipient('alex@attn.test')).toBe(true)
    expect(isCompleteRecipient('Alex Morgan <alex@attn.test>')).toBe(true)
  })

  it('leaves partial or invalid text to the suggestions', () => {
    expect(isCompleteRecipient('')).toBe(false)
    expect(isCompleteRecipient('alex')).toBe(false)
    expect(isCompleteRecipient('alex@')).toBe(false)
  })
})
