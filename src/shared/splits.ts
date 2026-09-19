export const IMPORTANT_SPLIT_ID = 'base:important'
export const OTHER_SPLIT_ID = 'fallback:other'

type SplitOperator = 'any' | 'all'

/**
 * Bounds on a described split. The lower bound rejects a fragment no model can
 * answer against; the upper bound keeps one question inside a single judgment.
 */
export const SPLIT_DESCRIPTION_MIN_LENGTH = 3
export const SPLIT_DESCRIPTION_MAX_LENGTH = 500

export type SplitCondition =
  | { type: 'senderAddress'; value: string }
  | { type: 'senderDomain'; value: string }
  | { type: 'listId'; value: string }
  | { type: 'listIdPresent' }
  | { type: 'label'; value: string }
  | { type: 'attachmentMimeType'; value: string }
  | { type: 'attachmentFilenameSuffix'; value: string }

export interface SplitMatchExpression {
  version: 1
  operator: SplitOperator
  conditions: SplitCondition[]
}

/**
 * `preset` is a legacy stored kind. Earlier setups seeded starter rules with it,
 * and those rows stay exactly as editable and deletable as a `custom` rule. No
 * code creates one, and nothing migrates one.
 */
export type SplitKind = 'preset' | 'base' | 'custom' | 'fallback'

/**
 * A split is described or rule-based, never both. A described rule carries the
 * prose a background classifier answers per thread and an empty `match`; a
 * rule-based rule carries a null description and at least one hard condition.
 */
export interface SplitRule {
  id: string
  position: number
  name: string
  kind: SplitKind
  description: string | null
  match: SplitMatchExpression
  notify: boolean
}

export interface SplitSummary extends SplitRule {
  total: number
  unread: number
}

export interface SplitState {
  revision: number
  splits: SplitSummary[]
}

export interface SplitThreadLocation {
  splitId: string
  revision: number
}

/** The two ways to define a split. `mode` picks the branch; neither carries the other's fields. */
export type SaveSplitInput =
  | {
      id?: string
      name: string
      notify: boolean
      mode: 'rules'
      operator: SplitOperator
      conditions: SplitCondition[]
    }
  | { id?: string; name: string; notify: boolean; mode: 'description'; description: string }

/**
 * Why the classifier gave up on a conversation. A lost network or a timed-out
 * request pauses the whole pass instead, so neither appears here.
 */
export type SplitTriageFailureCause = 'rate-limited' | 'rejected'

/** What the smart-splits surface reports about the classifier's progress. */
export interface SplitTriageStatus {
  enabled: boolean
  keyPresent: boolean
  /** True while the stored key is the one the service refused. Nothing judges. */
  keyRefused: boolean
  describedSplits: number
  judgedThreads: number
  /** Conversations still queued. It excludes the ones the pass gave up on. */
  pendingThreads: number
  /** Conversations that spent their attempt budget. `retryTriage` asks again. */
  failedThreads: number
  /** The distinct causes behind those failures; empty when none failed. */
  failedCauses: SplitTriageFailureCause[]
}

export interface ReorderSplitsInput {
  ids: string[]
}

export function canonicalizeListIdValue(value: string): string {
  const unfolded = value
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim()
    .toLowerCase()
  if (!unfolded) return ''
  const bracketed = [...unfolded.matchAll(/<([^<>]+)>/g)].map((match) => match[1]?.trim()).filter(Boolean)
  return bracketed[0] ? `<${bracketed[0]}>` : unfolded
}

export const EMPTY_SPLIT_MATCH: SplitMatchExpression = {
  version: 1,
  operator: 'any',
  conditions: []
}
