import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_IMAGE_POLICY,
  MailFrameRegistry,
  type RemoteImagePolicy,
  shouldBlockMailFrameImage
} from './remoteImages'

const blocking = (allowed: string[] = []): RemoteImagePolicy => ({
  blocked: true,
  allowedSenders: new Set(allowed)
})

describe('shouldBlockMailFrameImage', () => {
  it('passes everything while the default-load decision stands (§9 #5)', () => {
    expect(shouldBlockMailFrameImage(DEFAULT_REMOTE_IMAGE_POLICY, undefined)).toBe(false)
    expect(
      shouldBlockMailFrameImage(
        { blocked: false, allowedSenders: new Set() },
        { messageId: 'm1', sender: 'a@example.com', allowOnce: false }
      )
    ).toBe(false)
  })

  it('fails closed for an unregistered or sender-less frame while blocking', () => {
    expect(shouldBlockMailFrameImage(blocking(), undefined)).toBe(true)
    expect(
      shouldBlockMailFrameImage(blocking(['a@example.com']), {
        messageId: 'm1',
        sender: null,
        allowOnce: false
      })
    ).toBe(true)
  })

  it('admits exactly the Load once render', () => {
    expect(
      shouldBlockMailFrameImage(blocking(), { messageId: 'm1', sender: 'a@example.com', allowOnce: true })
    ).toBe(false)
    expect(
      shouldBlockMailFrameImage(blocking(), { messageId: 'm1', sender: 'a@example.com', allowOnce: false })
    ).toBe(true)
  })

  it('keys overrides on the normalized sender, not the image URL', () => {
    // Two messages referencing the same image URL from different senders get
    // different answers — the decision has no URL input at all.
    const policy = blocking(['allowed@example.com'])
    expect(
      shouldBlockMailFrameImage(policy, {
        messageId: 'm-allowed',
        sender: 'Allowed@Example.com',
        allowOnce: false
      })
    ).toBe(false)
    expect(
      shouldBlockMailFrameImage(policy, {
        messageId: 'm-blocked',
        sender: 'other@example.com',
        allowOnce: false
      })
    ).toBe(true)
  })
})

describe('MailFrameRegistry', () => {
  it('resolves only live nonces', () => {
    const registry = new MailFrameRegistry()
    registry.register('nonce-1', { messageId: 'm1', sender: 'a@example.com', allowOnce: false })
    expect(registry.get('nonce-1')?.messageId).toBe('m1')
    expect(registry.get('nonce-2')).toBeUndefined()
    expect(registry.get(null)).toBeUndefined()
    registry.unregister('nonce-1')
    expect(registry.get('nonce-1')).toBeUndefined()
  })
})
