export type MoveDestination =
  | { kind: 'done' }
  | { kind: 'inbox' }
  | { kind: 'spam' }
  | { kind: 'trash' }
  | { kind: 'important' }
  | { kind: 'other' }
  | { kind: 'label'; labelId: string }

export interface MoveLabelDelta {
  add: string[]
  remove: string[]
}

function unique(labels: readonly (string | null)[]): string[] {
  return [...new Set(labels.filter((label): label is string => Boolean(label)))]
}

/** The Gmail thread-label delta for one semantic Move destination. */
export function moveLabelDelta(destination: MoveDestination, sourceLabelId: string | null): MoveLabelDelta {
  const source = sourceLabelId ? [sourceLabelId] : []
  switch (destination.kind) {
    case 'done':
      return { add: [], remove: unique(['INBOX', 'SPAM', 'TRASH', ...source]) }
    case 'inbox':
      return { add: ['INBOX'], remove: unique(['SPAM', 'TRASH', ...source]) }
    case 'spam':
      return { add: ['SPAM'], remove: unique(['INBOX', 'TRASH', ...source]) }
    case 'trash':
      return { add: ['TRASH'], remove: unique(['INBOX', 'SPAM', ...source]) }
    case 'important':
      return { add: ['INBOX', 'IMPORTANT'], remove: unique(['SPAM', 'TRASH', ...source]) }
    case 'other':
      return { add: ['INBOX'], remove: unique(['IMPORTANT', 'SPAM', 'TRASH', ...source]) }
    case 'label':
      return {
        add: [destination.labelId],
        remove: unique(['INBOX', 'SPAM', 'TRASH', ...source])
      }
  }
}

export function isMoveDestination(value: unknown): value is MoveDestination {
  if (!value || typeof value !== 'object') return false
  const destination = value as Record<string, unknown>
  if (destination.kind === 'label') {
    return typeof destination.labelId === 'string' && destination.labelId.length > 0
  }
  return (
    destination.kind === 'done' ||
    destination.kind === 'inbox' ||
    destination.kind === 'spam' ||
    destination.kind === 'trash' ||
    destination.kind === 'important' ||
    destination.kind === 'other'
  )
}
