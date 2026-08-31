// Remote-image blocking policy (SPEC §6 Security, §9 #5, M4 T33). Enforcement
// lives in the main process's request layer: the renderer is sandboxed and
// runs untrusted mail markup, so it can never be the enforcement point. The
// reader registers each mounted mail frame under a nonce it sets as the
// iframe's `name` (scripts are disabled inside the frame, so the markup
// cannot rename it), and main resolves the frame's message to its sender
// through the local store — nothing in the markup or the request is trusted.

import { normalizeEmailKey } from '../shared/address'

export interface RemoteImagePolicy {
  /** The global toggle (settings row `remoteImages`); default load (§9 #5). */
  blocked: boolean
  /** Normalized sender addresses with `remoteImages:allow:<address>` rows. */
  allowedSenders: ReadonlySet<string>
}

export const DEFAULT_REMOTE_IMAGE_POLICY: RemoteImagePolicy = {
  blocked: false,
  allowedSenders: new Set()
}

export interface RegisteredMailFrame {
  messageId: string
  /** Resolved from the local store at registration; null when unknown. */
  sender: string | null
  /** One `Load once` render; cleared with the frame's registration. */
  allowOnce: boolean
}

/**
 * Decide one network request from a mail frame — images, but equally the
 * stylesheet, font, and media fetches hostile CSS can trigger (`@import`,
 * `@font-face`): every request type leaks the reader's IP and open time, so
 * the whole class shares one answer (PR #101 review). Pure so the matrix is
 * unit testable: default load passes everything; with blocking on, an
 * unregistered frame is denied (fail closed), `Load once` admits exactly the
 * registered render, and otherwise only a stored per-sender override loads.
 * Two messages from different senders can reference the same resource URL and
 * get different answers — the sender, not the URL, is the subject.
 */
export function shouldBlockMailFrameRequest(
  policy: RemoteImagePolicy,
  frame: RegisteredMailFrame | undefined
): boolean {
  if (!policy.blocked) return false
  if (!frame) return true
  if (frame.allowOnce) return false
  const sender = frame.sender ? normalizeEmailKey(frame.sender) : null
  return !(sender && policy.allowedSenders.has(sender))
}

/** Registry of live mail frames, keyed by the nonce in the iframe's name. */
export class MailFrameRegistry {
  private readonly frames = new Map<string, RegisteredMailFrame>()

  register(nonce: string, frame: RegisteredMailFrame): void {
    this.frames.set(nonce, frame)
  }

  unregister(nonce: string): void {
    this.frames.delete(nonce)
  }

  get(nonce: string | null | undefined): RegisteredMailFrame | undefined {
    return nonce ? this.frames.get(nonce) : undefined
  }
}
