import { randomUUID } from 'node:crypto'
import { isValidEmail, normalizeEmailKey } from '../shared/address'
import {
  canonicalizeListIdValue,
  EMPTY_SPLIT_MATCH,
  IMPORTANT_SPLIT_ID,
  OTHER_SPLIT_ID,
  type ReorderSplitsInput,
  type SaveSplitInput,
  SPLIT_PRESET_IDS,
  type SplitCondition,
  type SplitKind,
  type SplitMatchExpression,
  type SplitPresetId,
  type SplitRule,
  type SplitState,
  type SplitSummary,
  type SplitThreadLocation
} from '../shared/splits'
import type { Db } from './db'

interface StoredSplitRow {
  id: string
  position: number
  name: string
  kind: string
  match_json: string
  notify: number
}

export interface SplitAssignmentSql {
  sql: string
  params: unknown[]
  fallbackId: string
}

const CONDITION_TYPES = new Set<SplitCondition['type']>([
  'senderAddress',
  'senderDomain',
  'listId',
  'listIdPresent',
  'label',
  'attachmentMimeType',
  'attachmentFilenameSuffix'
])

const STARTER_RULES: readonly SplitRule[] = [
  {
    id: 'preset:calendar',
    position: 0,
    name: 'Calendar',
    kind: 'preset',
    match: {
      version: 1,
      operator: 'any',
      conditions: [
        { type: 'senderAddress', value: 'calendar-notification@google.com' },
        { type: 'senderAddress', value: 'notifications@cal.com' },
        { type: 'senderAddress', value: 'noreply@cal.com' },
        { type: 'attachmentMimeType', value: 'text/calendar' },
        { type: 'attachmentFilenameSuffix', value: '.ics' }
      ]
    },
    notify: false
  },
  {
    id: 'preset:github',
    position: 1,
    name: 'GitHub',
    kind: 'preset',
    match: {
      version: 1,
      operator: 'any',
      conditions: [{ type: 'senderDomain', value: 'github.com' }]
    },
    notify: false
  },
  {
    id: 'preset:newsletters',
    position: 2,
    name: 'Newsletters',
    kind: 'preset',
    match: {
      version: 1,
      operator: 'any',
      conditions: [{ type: 'listIdPresent' }, { type: 'label', value: 'CATEGORY_PROMOTIONS' }]
    },
    notify: false
  },
  {
    id: IMPORTANT_SPLIT_ID,
    position: 3,
    name: 'Important',
    kind: 'base',
    match: {
      version: 1,
      operator: 'any',
      conditions: [{ type: 'label', value: 'IMPORTANT' }]
    },
    notify: true
  },
  {
    id: OTHER_SPLIT_ID,
    position: 4,
    name: 'Other',
    kind: 'fallback',
    match: EMPTY_SPLIT_MATCH,
    notify: false
  }
] as const

const STARTER_RULES_BY_ID = new Map(STARTER_RULES.map((rule) => [rule.id, rule]))

function starterRule(id: string): SplitRule {
  const rule = STARTER_RULES_BY_ID.get(id)
  if (!rule) throw new Error(`Split starter rule is missing: ${id}`)
  return rule
}

export function canonicalListId(raw: string): string | null {
  const value = canonicalizeListIdValue(raw)
  return value || null
}

function normalizedCondition(condition: SplitCondition): SplitCondition | null {
  if (!CONDITION_TYPES.has(condition.type)) return null
  if (condition.type === 'listIdPresent') return { type: 'listIdPresent' }
  if (typeof condition.value !== 'string') return null
  const trimmed = condition.value.trim()
  if (!trimmed) return null
  if (condition.type === 'senderAddress') {
    const value = normalizeEmailKey(trimmed)
    return isValidEmail(value) ? { type: 'senderAddress', value } : null
  }
  if (condition.type === 'senderDomain') {
    const value = normalizeEmailKey(trimmed).replace(/^@+/, '')
    return value ? { type: 'senderDomain', value } : null
  }
  if (condition.type === 'listId') {
    const value = canonicalizeListIdValue(trimmed)
    return value ? { type: 'listId', value } : null
  }
  if (condition.type === 'label') return { type: 'label', value: trimmed.slice(0, 200) }
  return { type: condition.type, value: trimmed.toLowerCase().slice(0, 500) } as SplitCondition
}

export function normalizeSplitMatch(value: unknown): SplitMatchExpression | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { version?: unknown; operator?: unknown; conditions?: unknown }
  if (candidate.version !== 1 || (candidate.operator !== 'any' && candidate.operator !== 'all')) return null
  if (
    !Array.isArray(candidate.conditions) ||
    candidate.conditions.length === 0 ||
    candidate.conditions.length > 24
  ) {
    return null
  }
  const conditions: SplitCondition[] = []
  for (const raw of candidate.conditions) {
    if (!raw || typeof raw !== 'object') return null
    const type = (raw as { type?: unknown }).type
    if (typeof type !== 'string') return null
    const condition = normalizedCondition(raw as SplitCondition)
    if (!condition) return null
    conditions.push(condition)
  }
  return { version: 1, operator: candidate.operator, conditions }
}

export function parseSplitMatchJson(value: string): SplitMatchExpression | null {
  try {
    return normalizeSplitMatch(JSON.parse(value))
  } catch {
    return null
  }
}

function validKind(value: string): value is SplitKind {
  return value === 'preset' || value === 'base' || value === 'custom' || value === 'fallback'
}

function storedRows(db: Db, accountId: string): StoredSplitRow[] {
  return db
    .prepare(
      `SELECT id, position, name, kind, match_json, notify
       FROM split_rules
       WHERE account_id = ?
       ORDER BY position, id`
    )
    .all(accountId) as StoredSplitRow[]
}

function parseStoredRow(row: StoredSplitRow): SplitRule | null {
  if (!row.id || !row.name.trim() || !validKind(row.kind)) return null
  if (row.kind === 'fallback') {
    return row.id === OTHER_SPLIT_ID
      ? {
          id: row.id,
          position: row.position,
          name: row.name.trim(),
          kind: 'fallback',
          match: EMPTY_SPLIT_MATCH,
          notify: row.notify === 1
        }
      : null
  }
  if (row.kind === 'base') {
    const starter = STARTER_RULES_BY_ID.get(row.id)
    return starter?.kind === 'base'
      ? {
          id: row.id,
          position: row.position,
          name: row.name.trim(),
          kind: 'base',
          match: starter.match,
          notify: row.notify === 1
        }
      : null
  }
  const match = parseSplitMatchJson(row.match_json)
  if (!match) return null
  return {
    id: row.id,
    position: row.position,
    name: row.name.trim(),
    kind: row.kind,
    match,
    notify: row.notify === 1
  }
}

function visibleRules(db: Db, accountId: string): SplitRule[] {
  const parsed = storedRows(db, accountId)
    .flatMap((row) => {
      const parsedRule = parseStoredRow(row)
      return parsedRule ? [parsedRule] : []
    })
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
  if (parsed.some((rule) => rule.id === OTHER_SPLIT_ID)) return parsed
  return [...parsed, { ...starterRule(OTHER_SPLIT_ID), position: parsed.length }]
}

function rawRuleIds(db: Db, accountId: string): Set<string> {
  return new Set(storedRows(db, accountId).map((row) => row.id))
}

function insertRule(db: Db, accountId: string, rule: SplitRule): void {
  db.prepare(
    `INSERT INTO split_rules (account_id, id, position, name, kind, match_json, notify)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    rule.id,
    rule.position,
    rule.name,
    rule.kind,
    JSON.stringify(rule.match),
    rule.notify ? 1 : 0
  )
}

export function ensureSplitSetup(db: Db, accountId: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO split_config (account_id, initialized, revision)
       VALUES (?, 0, 0)`
    ).run(accountId)
    const config = db.prepare('SELECT initialized FROM split_config WHERE account_id = ?').get(accountId) as
      | { initialized: number }
      | undefined
    if (config?.initialized === 1) return
    const existing = rawRuleIds(db, accountId)
    for (const rule of STARTER_RULES) {
      if (!existing.has(rule.id)) insertRule(db, accountId, rule)
    }
    db.prepare(
      `UPDATE split_config
       SET initialized = 1, revision = revision + 1
       WHERE account_id = ?`
    ).run(accountId)
  })()
}

export function hasSplitSetup(db: Db, accountId: string): boolean {
  const row = db.prepare('SELECT initialized FROM split_config WHERE account_id = ?').get(accountId) as
    | { initialized: number }
    | undefined
  return row?.initialized === 1
}

export function splitRevision(db: Db, accountId: string): number {
  ensureSplitSetup(db, accountId)
  return (
    db.prepare('SELECT revision FROM split_config WHERE account_id = ?').get(accountId) as {
      revision: number
    }
  ).revision
}

function compileCondition(condition: SplitCondition): { sql: string; params: unknown[] } {
  if (condition.type === 'senderAddress') {
    return { sql: "lower(trim(COALESCE(m.from_email, ''))) = ?", params: [condition.value] }
  }
  if (condition.type === 'senderDomain') {
    const fromEmail = "lower(trim(COALESCE(m.from_email, '')))"
    return {
      sql: `CASE
              WHEN instr(${fromEmail}, '@') > 0
                THEN substr(${fromEmail}, instr(${fromEmail}, '@') + 1)
              ELSE ''
            END = ?`,
      params: [condition.value]
    }
  }
  if (condition.type === 'listId') {
    return { sql: 'm.list_id = ?', params: [condition.value] }
  }
  if (condition.type === 'listIdPresent') {
    return { sql: "m.list_id IS NOT NULL AND trim(m.list_id) <> ''", params: [] }
  }
  if (condition.type === 'label') {
    return {
      sql: `(
        (m.labels_json IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(m.labels_json) split_label
          WHERE split_label.value = ?
        )) OR (
          m.labels_json IS NULL AND EXISTS (
            SELECT 1 FROM thread_labels split_label_thread
            WHERE split_label_thread.account_id = t.account_id
              AND split_label_thread.thread_id = t.id
              AND split_label_thread.label_id = ?
          )
        )
      )`,
      params: [condition.value, condition.value]
    }
  }
  if (condition.type === 'attachmentMimeType') {
    return {
      sql: `(
        ${condition.value === 'text/calendar' ? 'm.has_calendar_part = 1 OR ' : ''}EXISTS (
          SELECT 1 FROM json_each(COALESCE(m.attachments_json, '[]')) split_attachment
          WHERE lower(trim(COALESCE(json_extract(split_attachment.value, '$.mimeType'), ''))) = ?
        )
      )`,
      params: [condition.value]
    }
  }
  const filename = "lower(trim(COALESCE(json_extract(split_attachment.value, '$.filename'), '')))"
  return {
    sql: `EXISTS (
      SELECT 1 FROM json_each(COALESCE(m.attachments_json, '[]')) split_attachment
      WHERE length(${filename}) >= length(?)
        AND substr(${filename}, length(${filename}) - length(?) + 1) = ?
    )`,
    params: [condition.value, condition.value, condition.value]
  }
}

function compileRuleMatch(match: SplitMatchExpression): { sql: string; params: unknown[] } {
  const compiled = match.conditions.map(compileCondition)
  return {
    sql: `EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id
        AND m.thread_id = t.id
        AND (${compiled.map((condition) => `(${condition.sql})`).join(` ${match.operator === 'all' ? 'AND' : 'OR'} `)})
    )`,
    params: compiled.flatMap((condition) => condition.params)
  }
}

export function compileSplitAssignment(rules: readonly SplitRule[]): SplitAssignmentSql {
  const ordered = [...rules].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id)
  )
  const fallback = ordered.find((rule) => rule.id === OTHER_SPLIT_ID)?.id ?? OTHER_SPLIT_ID
  const matching = ordered.filter((rule) => rule.id !== OTHER_SPLIT_ID)
  const branches: string[] = []
  const params: unknown[] = []
  for (const rule of matching) {
    const compiled = compileRuleMatch(rule.match)
    branches.push(`WHEN ${compiled.sql} THEN ?`)
    params.push(...compiled.params, rule.id)
  }
  params.push(fallback)
  return {
    sql: `CASE ${branches.join(' ')} ELSE ? END`,
    params,
    fallbackId: fallback
  }
}

export function splitAssignmentForAccount(db: Db, accountId: string): SplitAssignmentSql {
  ensureSplitSetup(db, accountId)
  return compileSplitAssignment(visibleRules(db, accountId))
}

function countBySplit(
  db: Db,
  accountId: string,
  rules: readonly SplitRule[]
): Map<string, { total: number; unread: number }> {
  const assignment = compileSplitAssignment(rules)
  const counts = db
    .prepare(
      `WITH classified AS (
         SELECT ${assignment.sql} AS split_id, t.is_unread
         FROM threads t
         JOIN thread_labels inbox
           ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
         WHERE t.account_id = ? AND t.is_inbox_visible = 1
       )
       SELECT split_id, COUNT(*) AS total, COALESCE(SUM(is_unread), 0) AS unread
       FROM classified
       GROUP BY split_id`
    )
    .all(...assignment.params, accountId) as { split_id: string; total: number; unread: number }[]
  return new Map(counts.map((row) => [row.split_id, { total: row.total, unread: row.unread }]))
}

export function getSplitState(db: Db, accountId: string): SplitState {
  ensureSplitSetup(db, accountId)
  return db.transaction(() => {
    const revision = splitRevision(db, accountId)
    const rules = visibleRules(db, accountId)
    const counts = countBySplit(db, accountId, rules)
    const splits: SplitSummary[] = rules.map((rule) => ({
      ...rule,
      ...(counts.get(rule.id) ?? { total: 0, unread: 0 })
    }))
    const visibleIds = new Set(rules.map((rule) => rule.id))
    return {
      revision,
      splits,
      restorablePresetIds: SPLIT_PRESET_IDS.filter((id) => !visibleIds.has(id))
    }
  })()
}

function bumpRevision(db: Db, accountId: string): void {
  db.prepare('UPDATE split_config SET revision = revision + 1 WHERE account_id = ?').run(accountId)
}

function compactPositions(db: Db, accountId: string): void {
  const ids = visibleRules(db, accountId)
    .filter((rule) => rule.id !== OTHER_SPLIT_ID)
    .map((rule) => rule.id)
  const update = db.prepare('UPDATE split_rules SET position = ? WHERE account_id = ? AND id = ?')
  ids.forEach((id, position) => {
    update.run(position, accountId, id)
  })
  update.run(ids.length, accountId, OTHER_SPLIT_ID)
}

function validatedSaveInput(input: SaveSplitInput): SaveSplitInput {
  const name = input.name.trim().slice(0, 64)
  if (!name) throw new Error('Split name is required')
  const match = normalizeSplitMatch({ version: 1, operator: input.operator, conditions: input.conditions })
  if (!match) throw new Error('Add at least one complete split condition')
  return { ...input, name, operator: match.operator, conditions: match.conditions }
}

export function saveSplit(db: Db, accountId: string, raw: SaveSplitInput): SplitState {
  ensureSplitSetup(db, accountId)
  const input = validatedSaveInput(raw)
  db.transaction(() => {
    const existing = input.id
      ? (db
          .prepare('SELECT id, kind FROM split_rules WHERE account_id = ? AND id = ?')
          .get(accountId, input.id) as { id: string; kind: SplitKind } | undefined)
      : undefined
    if (input.id && !existing) throw new Error('Split no longer exists')
    if (existing && existing.kind !== 'custom' && existing.kind !== 'preset') {
      throw new Error('Only custom and preset rules can be edited')
    }
    const match: SplitMatchExpression = {
      version: 1,
      operator: input.operator,
      conditions: input.conditions
    }
    if (existing) {
      db.prepare(
        `UPDATE split_rules
         SET name = ?, match_json = ?, notify = ?
         WHERE account_id = ? AND id = ?`
      ).run(input.name, JSON.stringify(match), input.notify ? 1 : 0, accountId, existing.id)
    } else {
      const position = (
        db
          .prepare("SELECT COUNT(*) AS count FROM split_rules WHERE account_id = ? AND kind <> 'fallback'")
          .get(accountId) as { count: number }
      ).count
      insertRule(db, accountId, {
        id: `custom:${randomUUID()}`,
        position,
        name: input.name,
        kind: 'custom',
        match,
        notify: input.notify
      })
    }
    compactPositions(db, accountId)
    bumpRevision(db, accountId)
  })()
  return getSplitState(db, accountId)
}

export function setSplitNotify(db: Db, accountId: string, id: string, notify: boolean): SplitState {
  ensureSplitSetup(db, accountId)
  const changed = db.transaction(() => {
    const result = db
      .prepare('UPDATE split_rules SET notify = ? WHERE account_id = ? AND id = ?')
      .run(notify ? 1 : 0, accountId, id)
    if (result.changes > 0) bumpRevision(db, accountId)
    return result.changes
  })()
  if (changed === 0) throw new Error('Split no longer exists')
  return getSplitState(db, accountId)
}

export function deleteSplit(db: Db, accountId: string, id: string): SplitState {
  ensureSplitSetup(db, accountId)
  const existing = db
    .prepare('SELECT kind FROM split_rules WHERE account_id = ? AND id = ?')
    .get(accountId, id) as { kind: SplitKind } | undefined
  if (!existing) throw new Error('Split no longer exists')
  if (existing.kind !== 'custom' && existing.kind !== 'preset') {
    throw new Error('Only custom and preset rules can be deleted')
  }
  db.transaction(() => {
    db.prepare('DELETE FROM split_rules WHERE account_id = ? AND id = ?').run(accountId, id)
    compactPositions(db, accountId)
    bumpRevision(db, accountId)
  })()
  return getSplitState(db, accountId)
}

export function reorderSplits(db: Db, accountId: string, input: ReorderSplitsInput): SplitState {
  ensureSplitSetup(db, accountId)
  db.transaction(() => {
    const currentIds = visibleRules(db, accountId)
      .filter((rule) => rule.id !== OTHER_SPLIT_ID)
      .map((rule) => rule.id)
    if (
      input.ids.length !== currentIds.length ||
      new Set(input.ids).size !== input.ids.length ||
      input.ids.some((id) => !currentIds.includes(id))
    ) {
      throw new Error('Split order is stale')
    }
    const update = db.prepare('UPDATE split_rules SET position = ? WHERE account_id = ? AND id = ?')
    input.ids.forEach((id, position) => {
      update.run(position, accountId, id)
    })
    update.run(input.ids.length, accountId, OTHER_SPLIT_ID)
    bumpRevision(db, accountId)
  })()
  return getSplitState(db, accountId)
}

export function restoreSplitPreset(db: Db, accountId: string, id: SplitPresetId): SplitState {
  ensureSplitSetup(db, accountId)
  const preset = STARTER_RULES_BY_ID.get(id)
  if (preset?.kind !== 'preset') throw new Error('Unknown split preset')
  db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id, position, name, kind, match_json, notify
         FROM split_rules
         WHERE account_id = ? AND id = ?`
      )
      .get(accountId, id) as StoredSplitRow | undefined
    if (existing && parseStoredRow(existing)) throw new Error('Split preset already exists')
    if (existing) {
      db.prepare('DELETE FROM split_rules WHERE account_id = ? AND id = ?').run(accountId, id)
    }
    const importantPosition = (
      db
        .prepare('SELECT position FROM split_rules WHERE account_id = ? AND id = ?')
        .get(accountId, IMPORTANT_SPLIT_ID) as { position: number } | undefined
    )?.position
    const position =
      importantPosition ??
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM split_rules WHERE account_id = ? AND kind <> 'fallback'")
          .get(accountId) as { count: number }
      ).count
    db.prepare(
      `UPDATE split_rules
       SET position = position + 1
       WHERE account_id = ? AND kind <> 'fallback' AND position >= ?`
    ).run(accountId, position)
    insertRule(db, accountId, { ...preset, position })
    compactPositions(db, accountId)
    bumpRevision(db, accountId)
  })()
  return getSplitState(db, accountId)
}

export function notificationEnabledSplitIds(db: Db, accountId: string): string[] {
  ensureSplitSetup(db, accountId)
  return visibleRules(db, accountId)
    .filter((rule) => rule.notify)
    .map((rule) => rule.id)
}

export function countNotificationEnabledUnread(db: Db, accountId: string): number {
  const enabledIds = notificationEnabledSplitIds(db, accountId)
  if (enabledIds.length === 0) return 0
  const assignment = splitAssignmentForAccount(db, accountId)
  const placeholders = enabledIds.map(() => '?').join(', ')
  return (
    db
      .prepare(
        // Badge work runs on every mail change, so classification starts from
        // the INBOX label index: scanning `threads` for the visible flag would
        // cost the whole account on every write, however small the Inbox is.
        `WITH classified AS (
           SELECT ${assignment.sql} AS split_id, t.is_unread
           FROM thread_labels inbox INDEXED BY idx_thread_labels_label
           JOIN threads t ON t.account_id = inbox.account_id AND t.id = inbox.thread_id
           WHERE inbox.account_id = ? AND inbox.label_id = 'INBOX' AND t.is_inbox_visible = 1
         )
         SELECT COALESCE(SUM(is_unread), 0) AS count
         FROM classified
         WHERE split_id IN (${placeholders})`
      )
      .get(...assignment.params, accountId, ...enabledIds) as { count: number }
  ).count
}

function splitIdForThread(db: Db, accountId: string, threadId: string): string | null {
  const assignment = splitAssignmentForAccount(db, accountId)
  const row = db
    .prepare(
      `SELECT ${assignment.sql} AS split_id
       FROM threads t
       JOIN thread_labels inbox
         ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
       WHERE t.account_id = ? AND t.id = ? AND t.is_inbox_visible = 1`
    )
    .get(...assignment.params, accountId, threadId) as { split_id: string } | undefined
  return row?.split_id ?? null
}

export function splitLocationForThread(
  db: Db,
  accountId: string,
  threadId: string
): SplitThreadLocation | null {
  ensureSplitSetup(db, accountId)
  return db.transaction(() => {
    const revision = splitRevision(db, accountId)
    const splitId = splitIdForThread(db, accountId, threadId)
    return splitId ? { splitId, revision } : null
  })()
}
