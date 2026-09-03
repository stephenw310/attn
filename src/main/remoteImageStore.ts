// Utility-process storage for the remote-image policy (T33). App-global under
// the settings sentinel (T32 rule 9): a privacy preference about a sender does
// not change per mailbox. The rows are `remoteImages` for the toggle and
// `remoteImages:allow:<address>` per sender override; the default stays load
// (§9 decision #5), so an absent toggle row means everything passes.

import { normalizeEmailKey } from '../shared/address'
import { remoteImagesBlocked } from './appSettings'
import type { Db } from './db'
import { APP_SETTINGS_ACCOUNT_ID, deleteSetting, writeSetting } from './settings'

const OVERRIDE_PREFIX = 'remoteImages:allow:'

/** Sender addresses with a stored Always-load override, normalized and sorted. */
export function listRemoteImageOverrides(db: Db): string[] {
  const rows = db
    .prepare('SELECT key FROM settings WHERE account_id = ? AND key LIKE ?')
    .all(APP_SETTINGS_ACCOUNT_ID, `${OVERRIDE_PREFIX}%`) as { key: string }[]
  return rows
    .map((row) => row.key.slice(OVERRIDE_PREFIX.length))
    .filter((address) => address.length > 0)
    .sort()
}

export function addRemoteImageOverride(db: Db, address: string): void {
  const normalized = normalizeEmailKey(address)
  if (!normalized) throw new Error('invalid sender address')
  writeSetting(db, `${OVERRIDE_PREFIX}${normalized}`, 'true')
}

export function removeRemoteImageOverride(db: Db, address: string): void {
  const normalized = normalizeEmailKey(address)
  if (!normalized) throw new Error('invalid sender address')
  deleteSetting(db, `${OVERRIDE_PREFIX}${normalized}`)
}

export interface StoredRemoteImagePolicy {
  blocked: boolean
  allowedSenders: string[]
}

export function storedRemoteImagePolicy(db: Db): StoredRemoteImagePolicy {
  return { blocked: remoteImagesBlocked(db), allowedSenders: listRemoteImageOverrides(db) }
}

/**
 * Resolve the sender behind a message id from the local store — the only
 * input the per-sender decision trusts (T33): the frame's markup and the
 * request URL never participate.
 */
export function resolveMessageSender(db: Db, accountId: string, messageId: string): string | null {
  const row = db
    .prepare('SELECT from_email FROM messages WHERE account_id = ? AND id = ?')
    .get(accountId, messageId) as { from_email: string | null } | undefined
  const sender = row?.from_email?.trim()
  return sender ? normalizeEmailKey(sender) : null
}
