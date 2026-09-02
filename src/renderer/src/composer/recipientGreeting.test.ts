import { describe, expect, it } from 'vitest'
import { recipientGreetingName, recipientGreetingSuggestion } from './recipientGreeting'

describe('recipient greeting completion', () => {
  it('uses the first given name from ordinary and address-book display names', () => {
    expect(recipientGreetingName({ name: 'Theo Park', email: 'theo@example.com' })).toBe('Theo')
    expect(recipientGreetingName({ name: 'Park, Theo', email: 'theo@example.com' })).toBe('Theo')
    expect(recipientGreetingName({ name: '', email: 'theo@example.com' })).toBeNull()
  })

  it('continues a fresh greeting, including a partially typed name', () => {
    expect(recipientGreetingSuggestion('Hi', '', 'Theo')).toBe(' Theo,')
    expect(recipientGreetingSuggestion('Hello ', '', 'Theo')).toBe('Theo,')
    expect(recipientGreetingSuggestion('Hi Th', '', 'Theo')).toBe('eo,')
  })

  it('does not intrude on other text or a body with content after the caret', () => {
    expect(recipientGreetingSuggestion('Thanks', '', 'Theo')).toBeNull()
    expect(recipientGreetingSuggestion('Hi Maya', '', 'Theo')).toBeNull()
    expect(recipientGreetingSuggestion('Hi', 'Existing body', 'Theo')).toBeNull()
  })
})
