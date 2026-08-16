import { describe, expect, it } from 'vitest'
import { decodeLabelDelta } from './queuePayload'

describe('action queue payloads', () => {
  it('preserves the user-facing action kind for ambiguous label deltas', () => {
    expect(decodeLabelDelta('{"add":["INBOX"],"remove":[],"actionKind":"unsnooze"}')).toEqual({
      add: ['INBOX'],
      remove: [],
      actionKind: 'unsnooze'
    })
    expect(decodeLabelDelta('{"add":["INBOX"],"remove":["SPAM"],"actionKind":"undo"}')).toEqual({
      add: ['INBOX'],
      remove: ['SPAM'],
      actionKind: 'undo'
    })
  })

  it('rejects malformed JSON and non-string label arrays', () => {
    expect(() => decodeLabelDelta('{not-json')).toThrow()
    expect(() => decodeLabelDelta('{"add":"INBOX","remove":[]}')).toThrow('label delta')
  })
})
