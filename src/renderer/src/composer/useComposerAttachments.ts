import { useCallback, useMemo, useRef, useState } from 'react'
import type { Draft } from '../../../shared/drafts'
import { errorMessage } from '../../../shared/error'
import type { ShowToast } from '../hooks/useToast'

function attachmentErrorMessage(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('Each attachment must be 25 MB or less')) {
    return 'Each attachment must be 25 MB or less'
  }
  if (message.includes('Attachments must total 25 MB or less')) {
    return 'Attachments must total 25 MB or less'
  }
  if (message.includes('Only files can be attached')) return 'Only files can be attached'
  if (message.includes('Attach no more than')) return message
  if (message.startsWith('Attachment is unavailable:')) return message
  if (message.startsWith('Could not copy attachment:')) return message
  if (message.startsWith('Attachments changed')) return message
  return 'Could not attach file'
}

export interface ComposerAttachments {
  attachments: Draft['attachments']
  /** Attachments with a chip; inline body images are removed by editing. */
  visibleAttachments: Draft['attachments']
  /** A pick, drop or removal is in flight; send and close must wait for it. */
  attaching: boolean
  attachmentError: string | null
  retryAttachment: () => void
  dismissAttachmentError: () => void
  /** True while a mutation is in flight, read synchronously by send/close. */
  isMutating: () => boolean
  addAttachment: (attachment: Draft['attachments'][number]) => void
  pickAttachments: () => void
  addDroppedFiles: (files: File[]) => void
  removeAttachment: (attachmentId: string) => void
  removeLastAttachment: () => void
}

/**
 * The composer's attachment machine: one mutation at a time, each replacing
 * the whole list main hands back, and every failure named for the user.
 * Lifted out of `Composer.tsx` (review R6); the guard has to stay readable
 * because send, close and discard all consult it.
 */
export function useComposerAttachments({
  draftId,
  initial,
  closing,
  onToast,
  onFieldsChanged
}: {
  draftId: string
  initial: Draft['attachments']
  closing: boolean
  onToast: ShowToast
  onFieldsChanged: (attachments: Draft['attachments']) => void
}): ComposerAttachments {
  const [attachments, setAttachments] = useState(initial)
  const [attaching, setAttaching] = useState(false)
  const mutatingRef = useRef(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const retryRequestRef = useRef<{
    request: () => Promise<{ attachments: Draft['attachments']; changed?: boolean }>
    failure: (error: unknown) => string
  } | null>(null)

  const replaceAttachments = useCallback(
    (next: Draft['attachments']) => {
      setAttachments(next)
      onFieldsChanged(next)
    },
    [onFieldsChanged]
  )

  const addAttachment = useCallback(
    (attachment: Draft['attachments'][number]) => {
      setAttachments((current) => {
        const next = [...current, attachment]
        onFieldsChanged(next)
        return next
      })
    },
    [onFieldsChanged]
  )

  const mutate = useCallback(
    (
      request: () => Promise<{ attachments: Draft['attachments']; changed?: boolean }>,
      failure: (error: unknown) => string
    ) => {
      if (closing || !window.attn) return
      if (mutatingRef.current) {
        onToast('Wait for the current attachment change to finish')
        return
      }
      mutatingRef.current = true
      setAttaching(true)
      setAttachmentError(null)
      retryRequestRef.current = null
      void request()
        .then((result) => {
          if (result.changed !== false) replaceAttachments(result.attachments)
        })
        .catch((error: unknown) => {
          const message = failure(error)
          setAttachmentError(message)
          retryRequestRef.current = { request, failure }
          onToast(message)
        })
        .finally(() => {
          mutatingRef.current = false
          setAttaching(false)
        })
    },
    [closing, onToast, replaceAttachments]
  )

  const retryAttachment = useCallback(() => {
    const retry = retryRequestRef.current
    if (retry) mutate(retry.request, retry.failure)
  }, [mutate])
  const dismissAttachmentError = useCallback(() => {
    setAttachmentError(null)
    retryRequestRef.current = null
  }, [])

  const pickAttachments = useCallback(() => {
    const bridge = window.attn
    if (!bridge) return
    mutate(() => bridge.draft.pickAttachments(draftId), attachmentErrorMessage)
  }, [draftId, mutate])

  const addDroppedFiles = useCallback(
    (files: File[]) => {
      const bridge = window.attn
      if (!bridge || files.length === 0) return
      mutate(() => bridge.draft.addDroppedFiles(draftId, files), attachmentErrorMessage)
    },
    [draftId, mutate]
  )

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      const bridge = window.attn
      if (!bridge) return
      mutate(
        () => bridge.draft.removeAttachment(draftId, attachmentId),
        () => 'Could not remove attachment'
      )
    },
    [draftId, mutate]
  )

  // Memoized so `removeLastAttachment` keeps its identity: it is one of the
  // handlers `ComposerCommandPlugin` lists in its effect, and a fresh array
  // per render re-registered all 14 composer commands on every keystroke (P2).
  const visibleAttachments = useMemo(
    () => attachments.filter((attachment) => !attachment.inline),
    [attachments]
  )

  // Attaching is keyboard-reachable, so removing has to be too. Inline body
  // images have no chip and are removed by editing the body instead.
  const removeLastAttachment = useCallback(() => {
    const last = visibleAttachments.at(-1)
    if (!last) {
      onToast('No attachments to remove')
      return
    }
    removeAttachment(last.id)
  }, [onToast, removeAttachment, visibleAttachments])

  const isMutating = useCallback(() => mutatingRef.current, [])

  return {
    attachments,
    visibleAttachments,
    attaching,
    attachmentError,
    retryAttachment,
    dismissAttachmentError,
    isMutating,
    addAttachment,
    pickAttachments,
    addDroppedFiles,
    removeAttachment,
    removeLastAttachment
  }
}
