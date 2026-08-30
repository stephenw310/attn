import { useEffect, useState } from 'react'
import type { ThreadListRequest, ThreadPageCursor } from '../../../shared/mail'
import { labelMailboxView, type PagedThreadView, userLabelId } from '../mailDisplay'

/**
 * Before paging beyond a saved scroll extent, check that the selected thread
 * still belongs to the view. Recheck after each page or mail/rule change so a
 * removed thread cannot make restoration scan the rest of the mailbox.
 * null means the current lookup is pending; false also covers read failures.
 */
export function useRestoreTarget(
  view: PagedThreadView | null,
  threadId: string | null,
  cursor: ThreadPageCursor | null,
  splitId: string | null,
  splitRevision: number | undefined,
  mailRevision: number
): boolean | null {
  const key = JSON.stringify([view, threadId, cursor, splitId, splitRevision, mailRevision])
  const [result, setResult] = useState<{ key: string; present: boolean } | null>(null)
  useEffect(() => {
    if (!view || !threadId || !window.attn) return
    const mailbox = labelMailboxView(view)
    const request: ThreadListRequest =
      view === 'inbox'
        ? { view, ...(splitId ? { splitId } : {}) }
        : view === 'snoozed' || mailbox
          ? { view: mailbox ?? 'snoozed' }
          : { view: 'label', labelId: userLabelId(view) ?? '' }
    let canceled = false
    void window.attn.mail
      .findThreadInView(request, threadId)
      .then((page) => {
        if (canceled) return
        // The list waits for the same rule revision before restoring a split.
        if (view === 'inbox' && splitId && page.splitRevision !== splitRevision) return
        setResult({ key, present: page.rows.some((row) => row.id === threadId) })
      })
      .catch(() => {
        if (!canceled) setResult({ key, present: false })
      })
    return () => {
      canceled = true
    }
  }, [key, splitId, splitRevision, threadId, view])
  if (!threadId || !window.attn) return false
  return result?.key === key ? result.present : null
}
