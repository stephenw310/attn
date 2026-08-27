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
    expect(decodeLabelDelta('{"add":["Label_2"],"remove":["INBOX"],"actionKind":"move"}')).toEqual({
      add: ['Label_2'],
      remove: ['INBOX'],
      actionKind: 'move'
    })
  })

  it('round-trips the reminder snapshot needed for local snooze recovery', () => {
    expect(
      decodeLabelDelta(
        '{"add":["INBOX"],"remove":[],"actionKind":"unsnooze","reminderBefore":{"dueAt":1234,"state":"pending"}}'
      )
    ).toEqual({
      add: ['INBOX'],
      remove: [],
      actionKind: 'unsnooze',
      reminderBefore: { dueAt: 1234, state: 'pending' }
    })
    expect(decodeLabelDelta('{"add":[],"remove":["INBOX"],"reminderBefore":null}')).toEqual({
      add: [],
      remove: ['INBOX'],
      reminderBefore: null
    })
  })

  it('rejects malformed JSON and non-string label arrays', () => {
    expect(() => decodeLabelDelta('{not-json')).toThrow()
    expect(() => decodeLabelDelta('{"add":"INBOX","remove":[]}')).toThrow('label delta')
    expect(() =>
      decodeLabelDelta('{"add":[],"remove":[],"reminderBefore":{"dueAt":"soon","state":"pending"}}')
    ).toThrow('reminder snapshot')
  })
})
