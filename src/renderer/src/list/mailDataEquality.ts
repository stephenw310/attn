import type { MailLabel, SnoozedThreadRow, ThreadRow } from '../../../shared/mail'

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameThread(left: ThreadRow, right: ThreadRow): boolean {
  return (
    left.id === right.id &&
    left.fromDisplay === right.fromDisplay &&
    left.subject === right.subject &&
    left.snippet === right.snippet &&
    left.lastMsgAt === right.lastMsgAt &&
    left.unread === right.unread &&
    left.starred === right.starred &&
    left.hasAttachment === right.hasAttachment &&
    left.snoozed === right.snoozed &&
    left.returned === right.returned &&
    // A follow-up firing can change ONLY these fields; missing them here made
    // the refresh reuse the stale rows, hiding the chip and heading until a
    // reload (T35/F9, PR #101 review).
    left.followUpReturned === right.followUpReturned &&
    left.followUpTierAt === right.followUpTierAt &&
    left.hasDraft === right.hasDraft &&
    sameStrings(left.labelIds, right.labelIds)
  )
}

export function reuseThreadRows(current: ThreadRow[] | null, next: ThreadRow[]): ThreadRow[] {
  return current !== null &&
    current.length === next.length &&
    current.every((thread, index) => sameThread(thread, next[index]))
    ? current
    : next
}

export function reuseSnoozedRows(
  current: SnoozedThreadRow[] | null,
  next: SnoozedThreadRow[]
): SnoozedThreadRow[] {
  return current !== null &&
    current.length === next.length &&
    current.every(
      (thread, index) =>
        sameThread(thread, next[index]) &&
        thread.dueAt === next[index].dueAt &&
        thread.snoozeDueAt === next[index].snoozeDueAt &&
        thread.followUpDueAt === next[index].followUpDueAt &&
        thread.followUpAwaiting === next[index].followUpAwaiting
    )
    ? current
    : next
}

export function reuseLabels(current: MailLabel[], next: MailLabel[]): MailLabel[] {
  return current.length === next.length &&
    current.every(
      (label, index) =>
        label.id === next[index].id &&
        label.name === next[index].name &&
        label.type === next[index].type &&
        label.threadCount === next[index].threadCount
    )
    ? current
    : next
}
