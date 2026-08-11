import { describe, expect, it } from 'vitest'
import { findTrimIndex } from './mailTrim'

describe('findTrimIndex', () => {
  it('finds RFC signatures', () => {
    expect(findTrimIndex('Thanks for the update.\n-- \nMaya Lin')).toBe('Thanks for the update.'.length)
  })

  it('finds authored reply headers and trailing quote runs', () => {
    expect(findTrimIndex('Sounds good.\nOn Monday, Priya wrote:\n> Earlier note')).toBe(
      'Sounds good.\n'.length
    )
    expect(findTrimIndex('Current answer.\n> Old line one\n> Old line two')).toBe('Current answer.'.length)
  })

  it('uses the first marker when signature and quote are both present', () => {
    expect(findTrimIndex('Reply.\n-- \nMaya\nOn Tuesday, Daniel wrote:\n> Old')).toBe('Reply.'.length)
  })

  it('finds common mobile signatures', () => {
    expect(findTrimIndex('See you there.\nSent from my iPhone')).toBe('See you there.'.length)
    expect(findTrimIndex('Approved.\nSent from my Galaxy S25')).toBe('Approved.'.length)
  })

  it('leaves normal text and mid-line delimiters untouched', () => {
    expect(findTrimIndex('No quoted content here.')).toBeNull()
    expect(findTrimIndex('Keep this -- text in the middle.')).toBeNull()
    expect(findTrimIndex('> Quoted example\nAuthored text after it.')).toBeNull()
  })

  it('never collapses an all-quote message to nothing', () => {
    expect(findTrimIndex('> Entire message\n> Still quoted')).toBeNull()
    expect(findTrimIndex('On Monday, Maya wrote:\n> Entire message')).toBeNull()
  })
})
