import { describe, expect, it } from 'vitest'
import { matchInlineSnippetTrigger, normalizeSnippetTrigger, subjectAfterSnippetInsert } from './snippets'

describe('matchInlineSnippetTrigger', () => {
  it('matches a trigger at the start of the text', () => {
    expect(matchInlineSnippetTrigger(';intro')).toEqual({ trigger: 'intro', start: 0 })
  })

  it('matches a trigger after whitespace and reports where the `;` sits', () => {
    expect(matchInlineSnippetTrigger('Hello ;intro')).toEqual({ trigger: 'intro', start: 6 })
    expect(matchInlineSnippetTrigger('line\n;sig')).toEqual({ trigger: 'sig', start: 5 })
    expect(matchInlineSnippetTrigger('a ;x')).toEqual({ trigger: 'x', start: 2 })
  })

  it('never fires on a mid-word semicolon (T34: deliberate, not eager)', () => {
    expect(matchInlineSnippetTrigger('abc;intro')).toBeNull()
    expect(matchInlineSnippetTrigger('9;intro')).toBeNull()
  })

  it('requires a word directly after the semicolon', () => {
    expect(matchInlineSnippetTrigger(';')).toBeNull()
    expect(matchInlineSnippetTrigger('; intro')).toBeNull()
    expect(matchInlineSnippetTrigger(';-intro')).toBeNull()
  })

  it('folds the typed trigger to lowercase so matching is case-insensitive', () => {
    expect(matchInlineSnippetTrigger(';Intro')).toEqual({ trigger: 'intro', start: 0 })
  })

  it('accepts - and _ inside the word', () => {
    expect(matchInlineSnippetTrigger(';follow-up_2')).toEqual({ trigger: 'follow-up_2', start: 0 })
  })
})

describe('normalizeSnippetTrigger', () => {
  it('canonicalizes: trims, drops the leading `;`, lowercases', () => {
    expect(normalizeSnippetTrigger(' ;Intro ')).toBe('intro')
    expect(normalizeSnippetTrigger('sig')).toBe('sig')
  })

  it('maps an empty field to null (no inline trigger)', () => {
    expect(normalizeSnippetTrigger('')).toBeNull()
    expect(normalizeSnippetTrigger('  ;')).toBeNull()
  })

  it('rejects shapes that can never fire inline', () => {
    expect(normalizeSnippetTrigger('two words')).toBeUndefined()
    expect(normalizeSnippetTrigger('-lead')).toBeUndefined()
    expect(normalizeSnippetTrigger(';;x')).toBeUndefined()
    expect(normalizeSnippetTrigger('a'.repeat(33))).toBeUndefined()
  })
})

describe('subjectAfterSnippetInsert', () => {
  it('fills an empty subject', () => {
    expect(subjectAfterSnippetInsert('', 'Quarterly check-in')).toBe('Quarterly check-in')
    expect(subjectAfterSnippetInsert('   ', 'Quarterly check-in')).toBe('Quarterly check-in')
  })

  it('never overwrites an existing subject (F8)', () => {
    expect(subjectAfterSnippetInsert('Re: roadmap', 'Quarterly check-in')).toBe('Re: roadmap')
  })

  it('leaves the subject alone when the snippet has none', () => {
    expect(subjectAfterSnippetInsert('', null)).toBe('')
    expect(subjectAfterSnippetInsert('kept', null)).toBe('kept')
  })
})
