import { describe, expect, it } from 'vitest'
import { emptyMailtoPrefill, parseMailtoUrl } from '../shared/mailto'
import {
  acknowledgePendingCompose,
  mailtoUrlFromArgv,
  PENDING_COMPOSE_TTL_MS,
  type PendingCompose,
  takePendingCompose
} from './mailtoLink'

function pending(at: number): PendingCompose {
  return { prefill: parseMailtoUrl('mailto:alex@example.com') ?? emptyMailtoPrefill(), at }
}

describe('takePendingCompose', () => {
  it('answers the request with its creation time as the id', () => {
    const request = pending(1_000)
    expect(takePendingCompose(request, 1_500)).toEqual({ id: 1_000, prefill: request.prefill })
  })

  it('answers null with nothing pending', () => {
    expect(takePendingCompose(null, 1_000)).toBeNull()
  })

  it('drops a request the renderer never came back for', () => {
    expect(takePendingCompose(pending(1_000), 1_000 + PENDING_COMPOSE_TTL_MS)).not.toBeNull()
    expect(takePendingCompose(pending(1_000), 1_001 + PENDING_COMPOSE_TTL_MS)).toBeNull()
  })

  it('does not consume: a second pull answers the same request', () => {
    const request = pending(1_000)
    expect(takePendingCompose(request, 1_100)).toEqual(takePendingCompose(request, 1_200))
  })
})

describe('acknowledgePendingCompose', () => {
  it('clears the request it names', () => {
    expect(acknowledgePendingCompose(pending(1_000), 1_000)).toBeNull()
  })

  it('leaves a newer request alone when a superseded id lands late', () => {
    const newer = pending(2_000)
    expect(acknowledgePendingCompose(newer, 1_000)).toBe(newer)
    expect(acknowledgePendingCompose(null, 1_000)).toBeNull()
  })
})

describe('mailtoUrlFromArgv', () => {
  it('finds the first mailto argument whatever its case or position', () => {
    expect(mailtoUrlFromArgv(['attn.exe', '--hidden', 'MailTo:alex@example.com?subject=Hi'])).toBe(
      'MailTo:alex@example.com?subject=Hi'
    )
    expect(mailtoUrlFromArgv(['attn', 'mailto:a@example.com', 'mailto:b@example.com'])).toBe(
      'mailto:a@example.com'
    )
  })

  it('answers null for an ordinary launch', () => {
    expect(mailtoUrlFromArgv(['attn.exe', '--hidden'])).toBeNull()
    expect(mailtoUrlFromArgv([])).toBeNull()
    expect(mailtoUrlFromArgv(['https://example.com'])).toBeNull()
  })
})
