import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_IMAGE_POLICY,
  fromAppFrame,
  MailFrameGrants,
  MailFrameRegistry,
  type RemoteImagePolicy,
  shouldBlockMailFrameRequest
} from './remoteImages'

const blocking = (allowed: string[] = []): RemoteImagePolicy => ({
  blocked: true,
  allowedSenders: new Set(allowed)
})

describe('shouldBlockMailFrameRequest', () => {
  it('passes everything while the default-load decision stands (§9 #5)', () => {
    expect(shouldBlockMailFrameRequest(DEFAULT_REMOTE_IMAGE_POLICY, undefined)).toBe(false)
    expect(
      shouldBlockMailFrameRequest(
        { blocked: false, allowedSenders: new Set() },
        { messageId: 'm1', sender: 'a@example.com', allowOnce: false }
      )
    ).toBe(false)
  })

  it('fails closed for an unregistered or sender-less frame while blocking', () => {
    expect(shouldBlockMailFrameRequest(blocking(), undefined)).toBe(true)
    expect(
      shouldBlockMailFrameRequest(blocking(['a@example.com']), {
        messageId: 'm1',
        sender: null,
        allowOnce: false
      })
    ).toBe(true)
  })

  it('admits exactly the Load once render', () => {
    expect(
      shouldBlockMailFrameRequest(blocking(), { messageId: 'm1', sender: 'a@example.com', allowOnce: true })
    ).toBe(false)
    expect(
      shouldBlockMailFrameRequest(blocking(), { messageId: 'm1', sender: 'a@example.com', allowOnce: false })
    ).toBe(true)
  })

  it('keys overrides on the normalized sender, not the image URL', () => {
    // Two messages referencing the same image URL from different senders get
    // different answers — the decision has no URL input at all.
    const policy = blocking(['allowed@example.com'])
    expect(
      shouldBlockMailFrameRequest(policy, {
        messageId: 'm-allowed',
        sender: 'Allowed@Example.com',
        allowOnce: false
      })
    ).toBe(false)
    expect(
      shouldBlockMailFrameRequest(policy, {
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

describe('MailFrameGrants', () => {
  // Registration reports where a frame is mounted and nothing more: a grant
  // exists only if the gesture call preceded it, and is spent by one mount.
  it('refuses a registration no gesture call preceded', () => {
    const grants = new MailFrameGrants()
    expect(grants.take('nonce-1', 'm1')).toBe(false)
    // Registering under that answer leaves the frame subject to the policy.
    const registry = new MailFrameRegistry()
    registry.register('nonce-1', {
      messageId: 'm1',
      sender: 'a@example.com',
      allowOnce: grants.take('nonce-1', 'm1')
    })
    expect(shouldBlockMailFrameRequest(blocking(), registry.get('nonce-1'))).toBe(true)
  })

  it('admits exactly the granted frame, once', () => {
    const grants = new MailFrameGrants()
    grants.allowOnceFor('nonce-1', 'm1')
    // Another frame of the same message, and the same nonce pointed at
    // another message, are both outside the grant.
    expect(grants.take('nonce-2', 'm1')).toBe(false)
    expect(grants.take('nonce-1', 'm2')).toBe(false)
    grants.allowOnceFor('nonce-1', 'm1')
    expect(grants.take('nonce-1', 'm1')).toBe(true)
    // Spent: a re-render mints a fresh nonce and is blocked again.
    expect(grants.take('nonce-1', 'm1')).toBe(false)
  })

  it('bounds grants whose registration never arrives', () => {
    const grants = new MailFrameGrants(2)
    grants.allowOnceFor('nonce-1', 'm1')
    grants.allowOnceFor('nonce-2', 'm1')
    grants.allowOnceFor('nonce-3', 'm1')
    expect(grants.take('nonce-1', 'm1')).toBe(false)
    expect(grants.take('nonce-2', 'm1')).toBe(true)
    expect(grants.take('nonce-3', 'm1')).toBe(true)
  })
})

describe('fromAppFrame', () => {
  it('accepts only the window main frame as the caller', () => {
    const main = { frameToken: 'main' }
    const child = { frameToken: 'child' }
    expect(fromAppFrame({ senderFrame: main, sender: { mainFrame: main } })).toBe(true)
    expect(fromAppFrame({ senderFrame: child, sender: { mainFrame: main } })).toBe(false)
    // A disposed sender frame is no evidence at all.
    expect(fromAppFrame({ senderFrame: null, sender: { mainFrame: main } })).toBe(false)
  })
})
