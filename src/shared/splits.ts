export const IMPORTANT_SPLIT_ID = 'base:important'
export const OTHER_SPLIT_ID = 'fallback:other'

export const SPLIT_PRESET_IDS = ['preset:calendar', 'preset:github', 'preset:newsletters'] as const

export type SplitPresetId = (typeof SPLIT_PRESET_IDS)[number]
export type SplitOperator = 'any' | 'all'

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

export type SplitKind = 'preset' | 'base' | 'custom' | 'fallback'

export interface SplitRule {
  id: string
  position: number
  name: string
  kind: SplitKind
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
  restorablePresetIds: SplitPresetId[]
}

export interface SplitThreadLocation {
  splitId: string
  revision: number
}

export interface SaveSplitInput {
  id?: string
  name: string
  operator: SplitOperator
  conditions: SplitCondition[]
  notify: boolean
}

export interface ReorderSplitsInput {
  ids: string[]
}

export interface SetSplitNotifyInput {
  id: string
  notify: boolean
}

export function splitConditionNeedsValue(type: SplitCondition['type']): boolean {
  return type !== 'listIdPresent'
}

export function isSplitPresetId(value: unknown): value is SplitPresetId {
  return typeof value === 'string' && (SPLIT_PRESET_IDS as readonly string[]).includes(value)
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
