import { createHash, randomUUID } from 'node:crypto'
import { isValidEmail, normalizeEmailKey } from '../shared/address'
import {
  canonicalizeListIdValue,
  EMPTY_SPLIT_MATCH,
  IMPORTANT_SPLIT_ID,
  OTHER_SPLIT_ID,
  type ReorderSplitsInput,
  type SaveSplitInput,
  SPLIT_DESCRIPTION_MAX_LENGTH,
  SPLIT_DESCRIPTION_MIN_LENGTH,
  type SplitCondition,
  type SplitKind,
  type SplitMatchExpression,
  type SplitRule,
  type SplitState,
  type SplitSummary,
  type SplitThreadLocation
} from '../shared/splits'
import type { Db } from './db'
import { messageHasLabelSql } from './db/labelSql'
import { SPLIT_TRIAGE_THRESHOLD } from './sync/tuning'

/** Rules are compiled against `messages m` joined to the listed thread `t`. */
const THREAD_KEY = { accountId: 't.account_id', id: 't.id' }

interface StoredSplitRow {
  id: string
  position: number
  name: string
  kind: string
  match_json: string
  notify: number
  description: string | null
}

const STORED_ROW_COLUMNS = 'id, position, name, kind, match_json, notify, description'

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

/**
 * What a first split setup creates. AI rules and manual rules are how a user
 * adds the rest, so nothing else is seeded.
 */
const STARTER_RULES: readonly SplitRule[] = [
  {
    id: IMPORTANT_SPLIT_ID,
    position: 0,
    name: 'Important',
    kind: 'base',
    description: null,
    match: {
      version: 1,
      operator: 'any',
      conditions: [{ type: 'label', value: 'IMPORTANT' }]
    },
    notify: true
  },
  {
    id: OTHER_SPLIT_ID,
    position: 1,
    name: 'Other',
    kind: 'fallback',
    description: null,
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

/**
 * The stored form of a split's prose: one space between words, no surrounding
 * space, original case. The model reads this text, so case carries meaning.
 */
function collapsedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * The stored description, or null when the text is unusable. Too long is a
 * mistake to report, not something to silently truncate: a cut description asks
 * a different question than the one the user wrote.
 */
export function normalizeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = collapsedText(value)
  if (collapsed.length < SPLIT_DESCRIPTION_MIN_LENGTH || collapsed.length > SPLIT_DESCRIPTION_MAX_LENGTH) {
    return null
  }
  return collapsed
}

/**
 * Names the exact question a judgment answered: the split's name and its
 * description text. The request carries both — the name is in the instructions
 * the model reads — so a rename asks a different question just as an edited
 * description does. Either change alters the hash, so the earlier judgments
 * stop matching and the classifier asks again instead of inheriting answers to
 * a question nobody asks. The stored column keeps the name `description_hash`.
 */
export function judgmentHash(name: string, description: string): string {
  const question = `${collapsedText(name)}\n${collapsedText(description)}`
  return createHash('sha256').update(question).digest('hex')
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

/**
 * The rules a user owns. `preset` is the legacy stored kind of the starter rules
 * an earlier setup seeded; it is read exactly like `custom`, so those rows stay
 * editable and deletable and never need a migration.
 */
function userOwnedKind(kind: SplitKind): boolean {
  return kind === 'custom' || kind === 'preset'
}

function storedRows(db: Db, accountId: string): StoredSplitRow[] {
  return db
    .prepare(
      `SELECT ${STORED_ROW_COLUMNS}
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
          description: null,
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
          description: null,
          match: starter.match,
          notify: row.notify === 1
        }
      : null
  }
  // Description wins. A row that somehow carries both a description and stored
  // conditions is a described split, and its conditions are ignored: the two
  // modes are exclusive, and reading them together would compile a rule the
  // user never wrote.
  const description = normalizeDescription(row.description)
  if (description !== null) {
    return {
      id: row.id,
      position: row.position,
      name: row.name.trim(),
      kind: row.kind,
      description,
      match: EMPTY_SPLIT_MATCH,
      notify: row.notify === 1
    }
  }
  const match = parseSplitMatchJson(row.match_json)
  if (!match) return null
  return {
    id: row.id,
    position: row.position,
    name: row.name.trim(),
    kind: row.kind,
    description: null,
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
    `INSERT INTO split_rules (account_id, id, position, name, kind, match_json, notify, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    rule.id,
    rule.position,
    rule.name,
    rule.kind,
    JSON.stringify(rule.match),
    rule.notify ? 1 : 0,
    rule.description
  )
}

export function hasSplitSetup(db: Db, accountId: string): boolean {
  const row = db.prepare('SELECT initialized FROM split_config WHERE account_id = ?').get(accountId) as
    | { initialized: number }
    | undefined
  return row?.initialized === 1
}

/**
 * Seed the starter rules once per account. Reads run on every Inbox page, badge
 * count and notification check, so the already-initialized case must stay a
 * pure SELECT: opening a write transaction there made every read a write.
 */
export function ensureSplitSetup(db: Db, accountId: string): void {
  if (hasSplitSetup(db, accountId)) return
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

/** Pure read: `ensureSplitSetup` owns creating the row at account setup. */
export function splitRevision(db: Db, accountId: string): number {
  const row = db.prepare('SELECT revision FROM split_config WHERE account_id = ?').get(accountId) as
    | { revision: number }
    | undefined
  return row?.revision ?? 0
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
    // Both binds are the label: the stored test reads it first, the legacy
    // thread-level fallback second.
    return {
      sql: messageHasLabelSql({ message: 'm', label: '?', thread: THREAD_KEY }),
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

/**
 * Takes the whole rule, not just its expression: a described split is answered
 * per thread, so it compiles straight to its judgment test with no `messages m`
 * walk. A rule-based split keeps the message walk, which is what makes `all`
 * mean "one message satisfies every condition".
 */
function compileRuleMatch(rule: SplitRule): { sql: string; params: unknown[] } {
  if (rule.description !== null) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM split_judgments j
        WHERE j.account_id = ${THREAD_KEY.accountId}
          AND j.thread_id = ${THREAD_KEY.id}
          AND j.split_id = ?
          AND j.description_hash = ?
          AND j.probability >= ?
      )`,
      params: [rule.id, judgmentHash(rule.name, rule.description), SPLIT_TRIAGE_THRESHOLD]
    }
  }
  const match = rule.match
  const compiled = match.conditions.map((condition) => compileCondition(condition))
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
    const compiled = compileRuleMatch(rule)
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
    return { revision, splits }
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

/** One shape for both modes: the description and the match are never both set. */
interface ValidatedSaveInput {
  id?: string
  name: string
  notify: boolean
  description: string | null
  match: SplitMatchExpression
}

function validatedSaveInput(input: SaveSplitInput): ValidatedSaveInput {
  const name = input.name.trim().slice(0, 64)
  if (!name) throw new Error('Split name is required')
  const common = { ...(input.id === undefined ? {} : { id: input.id }), name, notify: input.notify }
  if (input.mode === 'description') {
    const description = normalizeDescription(input.description)
    if (!description) {
      throw new Error(
        `Describe the split in ${SPLIT_DESCRIPTION_MIN_LENGTH} to ${SPLIT_DESCRIPTION_MAX_LENGTH} characters`
      )
    }
    return { ...common, description, match: EMPTY_SPLIT_MATCH }
  }
  const match = normalizeSplitMatch({ version: 1, operator: input.operator, conditions: input.conditions })
  if (!match) throw new Error('Add at least one complete split condition')
  return { ...common, description: null, match }
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
    if (existing && !userOwnedKind(existing.kind)) {
      throw new Error('Only custom rules can be edited')
    }
    if (existing) {
      // `description` is always written, so switching a described split back to
      // conditions clears the prose instead of leaving it to win the next read.
      db.prepare(
        `UPDATE split_rules
         SET name = ?, match_json = ?, notify = ?, description = ?
         WHERE account_id = ? AND id = ?`
      ).run(
        input.name,
        JSON.stringify(input.match),
        input.notify ? 1 : 0,
        input.description,
        accountId,
        existing.id
      )
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
        description: input.description,
        match: input.match,
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
  if (!userOwnedKind(existing.kind)) {
    throw new Error('Only custom rules can be deleted')
  }
  db.transaction(() => {
    db.prepare('DELETE FROM split_rules WHERE account_id = ? AND id = ?').run(accountId, id)
    // A judgment answers one split's question. Left behind it is an orphan the
    // account carries for good, and a new split that reused the id would read it.
    db.prepare('DELETE FROM split_judgments WHERE account_id = ? AND split_id = ?').run(accountId, id)
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

/** One rule-based split a test fixture asks for, with the id it must keep. */
export interface SeedSplitRule {
  id: string
  name: string
  operator: SplitMatchExpression['operator']
  conditions: SplitCondition[]
  notify: boolean
}

/**
 * Seed fixture rules ahead of the starter rules, in the order given. Test-only:
 * `loadSeed` calls it so a fixture can exercise rule-based splits with stable
 * ids. It writes through the same insert as production, so the seam never grows
 * SQL of its own.
 *
 * `reloadSeed` replays a fixture into the same profile, so this skips a rule the
 * account already holds and leaves whatever the test did to it.
 */
export function insertSeedSplitRules(db: Db, accountId: string, rules: readonly SeedSplitRule[]): void {
  if (rules.length === 0) return
  db.transaction(() => {
    const existing = rawRuleIds(db, accountId)
    const missing = rules.filter((rule) => !existing.has(rule.id))
    if (missing.length === 0) return
    // Existing rules move down first. A tie on `position` breaks on id, so an
    // inserted rule that shares Important's position could sort behind it.
    db.prepare(
      `UPDATE split_rules
       SET position = position + ?
       WHERE account_id = ? AND kind <> 'fallback'`
    ).run(missing.length, accountId)
    missing.forEach((rule, position) => {
      const match = normalizeSplitMatch({
        version: 1,
        operator: rule.operator,
        conditions: rule.conditions
      })
      if (!match) throw new Error(`Seed split rule ${rule.id} has no usable condition`)
      insertRule(db, accountId, {
        id: rule.id,
        position,
        name: rule.name,
        kind: 'custom',
        description: null,
        match,
        notify: rule.notify
      })
    })
    compactPositions(db, accountId)
    bumpRevision(db, accountId)
  })()
}

/**
 * The notification and badge path reaches accounts the caller has not otherwise
 * opened, including background roster members, so this is the one reader that
 * still seeds setup. `ensureSplitSetup` is a pure SELECT once that has happened.
 */
export function notificationEnabledSplitIds(db: Db, accountId: string): string[] {
  ensureSplitSetup(db, accountId)
  return visibleRules(db, accountId)
    .filter((rule) => rule.notify)
    .map((rule) => rule.id)
}

/**
 * The described splits the classifier has to answer for, in rule order. Each
 * carries the exact hash a judgment must record, so a caller never re-derives
 * it from the prose and risks disagreeing with the compiled condition.
 */
export interface DescribedSplitRule {
  splitId: string
  name: string
  description: string
  /** `judgmentHash(name, description)`: the stored `description_hash` value. */
  descriptionHash: string
}

export function describedSplitRules(db: Db, accountId: string): DescribedSplitRule[] {
  return visibleRules(db, accountId).flatMap((rule) =>
    rule.description === null
      ? []
      : [
          {
            splitId: rule.id,
            name: rule.name,
            description: rule.description,
            descriptionHash: judgmentHash(rule.name, rule.description)
          }
        ]
  )
}

/**
 * The judgment identity one stored rule asks under right now, or null when the
 * split is gone, is not the user's to describe, or no longer carries prose.
 * The classifier re-reads this inside its write transaction: a pack claimed
 * before a delete or an edit must not land a row answering the old question.
 */
export function storedJudgmentHash(db: Db, accountId: string, splitId: string): string | null {
  const row = db
    .prepare('SELECT name, kind, description FROM split_rules WHERE account_id = ? AND id = ?')
    .get(accountId, splitId) as { name: string; kind: string; description: string | null } | undefined
  if (!row || !validKind(row.kind) || !userOwnedKind(row.kind)) return null
  const description = normalizeDescription(row.description)
  return description === null ? null : judgmentHash(row.name, description)
}

/**
 * "Some described split has no current answer for this thread." One definition
 * shared by the classifier's work query and the status counts, so the queue and
 * the number reported for it can never disagree.
 *
 * It asks about presence, not about a yes: a confident no is a current answer.
 * `threadId` and `evidenceKey` are the caller's column expressions, and the
 * returned params bind per rule in `rules` order.
 */
export function pendingJudgmentPredicate(
  accountId: string,
  rules: readonly DescribedSplitRule[],
  columns: { threadId: string; evidenceKey: string }
): { sql: string; params: unknown[] } {
  // An empty list has no honest answer here: an empty disjunction would compile
  // to `AND ()`. Callers ask only once they know a described split exists.
  if (rules.length === 0) throw new Error('A pending-judgment test needs at least one described split')
  const clauses = rules.map(
    () =>
      `NOT EXISTS (
         SELECT 1 FROM split_judgments j
         WHERE j.account_id = ?
           AND j.thread_id = ${columns.threadId}
           AND j.split_id = ?
           AND j.description_hash = ?
           AND j.evidence_key = ${columns.evidenceKey}
       )`
  )
  return {
    sql: clauses.join(' OR '),
    params: rules.flatMap((rule) => [accountId, rule.splitId, rule.descriptionHash])
  }
}

/**
 * The classifier's candidate threads: Inbox-visible INBOX conversations with at
 * least one stored message. `splitTriageCounts` and the pass walk the same set,
 * so a thread counted as pending is one the pass will actually pick up.
 */
const TRIAGE_CANDIDATE_SQL = `SELECT t.id AS thread_id,
         COALESCE(t.last_msg_at, 0) AS sort_at,
         (SELECT m.id FROM messages m
            WHERE m.account_id = t.account_id AND m.thread_id = t.id
            ORDER BY m.internal_date DESC, m.id DESC
            LIMIT 1) AS latest_message_id
  FROM threads t
  JOIN thread_labels inbox
    ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
  WHERE t.account_id = ? AND t.is_inbox_visible = 1`

export function triageCandidateSql(extraFilters = ''): string {
  return `${TRIAGE_CANDIDATE_SQL} ${extraFilters}`
}

export interface SplitTriageCounts {
  describedSplits: number
  judgedThreads: number
  pendingThreads: number
  failedThreads: number
}

/**
 * How far the classifier has got. `judged` is every candidate that is not
 * pending, so a thread with no stored message counts as neither: it is not
 * work the pass can do.
 *
 * `failedThreadIds` are the conversations the pass has given up on. They are
 * still unanswered, so they are counted here and taken out of `pending`: a
 * surface that showed them as pending would report work nobody is doing. The
 * ids travel as one JSON parameter, because a broken service can fail an
 * entire Inbox.
 */
export function splitTriageCounts(
  db: Db,
  accountId: string,
  failedThreadIds: ReadonlySet<string> = new Set()
): SplitTriageCounts {
  const rules = describedSplitRules(db, accountId)
  const empty = { describedSplits: 0, judgedThreads: 0, pendingThreads: 0, failedThreads: 0 }
  if (rules.length === 0) return empty
  const pending = pendingJudgmentPredicate(accountId, rules, {
    threadId: 'candidate.thread_id',
    evidenceKey: 'candidate.latest_message_id'
  })
  const failedSql =
    failedThreadIds.size > 0
      ? `SUM(CASE WHEN (${pending.sql})
                   AND candidate.thread_id IN (SELECT value FROM json_each(?))
                  THEN 1 ELSE 0 END)`
      : '0'
  // The failed column repeats the pending predicate, so it repeats its params.
  const failedParams =
    failedThreadIds.size > 0 ? [...pending.params, JSON.stringify([...failedThreadIds])] : []
  const row = db
    .prepare(
      `WITH candidate AS (${triageCandidateSql()})
       SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${pending.sql} THEN 1 ELSE 0 END) AS pending,
              ${failedSql} AS failed
       FROM candidate
       WHERE latest_message_id IS NOT NULL`
    )
    .get(accountId, ...pending.params, ...failedParams) as {
    total: number
    pending: number | null
    failed: number | null
  }
  const unanswered = row.pending ?? 0
  const failedThreads = row.failed ?? 0
  return {
    describedSplits: rules.length,
    judgedThreads: row.total - unanswered,
    pendingThreads: unanswered - failedThreads,
    failedThreads
  }
}

/** Announce that split membership changed underneath the renderer's cached pages. */
export function bumpSplitRevision(db: Db, accountId: string): void {
  bumpRevision(db, accountId)
}

export function splitIdForThread(db: Db, accountId: string, threadId: string): string | null {
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
  return db.transaction(() => {
    const revision = splitRevision(db, accountId)
    const splitId = splitIdForThread(db, accountId, threadId)
    return splitId ? { splitId, revision } : null
  })()
}
