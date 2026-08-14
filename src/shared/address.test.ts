import { describe, expect, it } from 'vitest'
import { isValidEmail, parseRecipientInput } from './address'

describe('recipient chip parsing', () => {
  it('keeps quoted commas and normalizes angle-bracket addresses', () => {
    expect(parseRecipientInput('"Lin, Maya" <maya@example.com>, priya@example.com')).toEqual({
      recipients: [
        { name: 'Lin, Maya', email: 'maya@example.com' },
        { name: 'priya', email: 'priya@example.com' }
      ],
      invalid: []
    })
  })

  it('surfaces invalid tokens instead of turning them into chips', () => {
    expect(parseRecipientInput('not-an-address')).toEqual({
      recipients: [],
      invalid: ['not-an-address']
    })
    expect(isValidEmail('person@example.com')).toBe(true)
    expect(isValidEmail('person @example.com')).toBe(false)
  })
})
