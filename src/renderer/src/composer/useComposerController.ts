import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { MailAddress } from '../../../shared/address'
import { AI_PROVIDER_PRESETS } from '../../../shared/ai'
import type { Draft } from '../../../shared/drafts'
import { errorMessage } from '../../../shared/error'
import { escapeHtmlText as escapeHtml } from '../../../shared/html'
import { type Snippet, subjectAfterSnippetInsert } from '../../../shared/snippets'
import { matchComposerKey } from '../commands'
import type { ShowToast } from '../hooks/useToast'
import type { ComposerHandle } from './Composer'
import { prepareHtmlForEditor } from './preserve'
import type { RecipientFieldHandle } from './RecipientField'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerDraft } from './useComposerDraft'

interface ComposerControllerOptions {
  draft: Draft
  mode: 'full' | 'inline'
  initialError: string | null
  onClose: () => void
  onExit?: () => void
  onToast: ShowToast
  supportsAiDraft: boolean
  ref: React.ForwardedRef<ComposerHandle>
}

function plainTextForEditor(value: string): string {
  if (!value) return ''
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>`
}

function hasGmailSignature(html: string): boolean {
  if (!html) return false
  const document = new DOMParser().parseFromString(html, 'text/html')
  return document.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]') !== null
}

export function useComposerController({
  draft,
  mode,
  initialError,
  onClose,
  onExit,
  onToast,
  supportsAiDraft,
  ref
}: ComposerControllerOptions) {
  const initialHtml = draft.bodyHtml || plainTextForEditor(draft.bodyText)
  const preparedHtml = useMemo(() => prepareHtmlForEditor(initialHtml), [initialHtml])
  const [to, setTo] = useState<MailAddress[]>(draft.to)
  const [cc, setCc] = useState<MailAddress[]>(draft.cc)
  const [bcc, setBcc] = useState<MailAddress[]>(draft.bcc)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [subject, setSubject] = useState(draft.subject)
  const [followUpAt, setFollowUpAt] = useState<number | null>(draft.followUpAt)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [closing, setClosing] = useState(false)
  const [sendError, setSendError] = useState<string | null>(initialError)
  const [aiTipReady, setAiTipReady] = useState(false)
  const [unifiedContentExpanded, setUnifiedContentExpanded] = useState(false)
  const [hasPreservedContent, setHasPreservedContent] = useState(preparedHtml.issues.length > 0)
  const toFieldRef = useRef<RecipientFieldHandle | null>(null)
  const ccFieldRef = useRef<RecipientFieldHandle | null>(null)
  const bccFieldRef = useRef<RecipientFieldHandle | null>(null)
  const unifiedSignatureAndQuote = useMemo(
    () => Boolean(draft.quoteHtml) && hasGmailSignature(preparedHtml.html),
    [draft.quoteHtml, preparedHtml.html]
  )
  const revealUnifiedContent = useCallback(() => setUnifiedContentExpanded(true), [])
  const notePreservedContent = useCallback(() => setHasPreservedContent(true), [])

  useEffect(() => {
    setAiTipReady(false)
    if (!supportsAiDraft || !window.attn) return
    let stale = false
    void window.attn.ai
      .getSettings()
      .then((settings) => {
        const keyReady = settings.keyPresent || !AI_PROVIDER_PRESETS[settings.provider].keyRequired
        if (!stale) setAiTipReady(settings.enabled && keyReady)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [supportsAiDraft])

  const commitPendingRecipients = useCallback((reportInvalid = true) => {
    let valid = true
    for (const fieldRef of [toFieldRef, ccFieldRef, bccFieldRef]) {
      if (!(fieldRef.current?.commitPending(reportInvalid) ?? true)) valid = false
    }
    return valid
  }, [])
  const prepareSnapshot = useCallback(() => commitPendingRecipients(false), [commitPendingRecipients])
  const { captureEditor, localRevision, savedRevision, saveNow, saveStatus, updateFields } = useComposerDraft(
    draft,
    prepareSnapshot
  )
  const notePendingRecipientChange = useCallback(() => updateFields({}), [updateFields])
  const noteAiContentSettled = useCallback(() => updateFields({}), [updateFields])
  const subjectRef = useRef(subject)
  subjectRef.current = subject
  const handleSnippetInserted = useCallback(
    (snippet: Snippet) => {
      const next = subjectAfterSnippetInsert(subjectRef.current, snippet.subject)
      if (next === subjectRef.current) return
      setSubject(next)
      updateFields({ subject: next })
    },
    [updateFields]
  )
  const noteAttachmentsChanged = useCallback(
    (attachments: Draft['attachments']) => updateFields({ attachments }),
    [updateFields]
  )
  const {
    attaching,
    isMutating,
    addAttachment,
    pickAttachments,
    addDroppedFiles,
    removeAttachment,
    removeLastAttachment,
    visibleAttachments
  } = useComposerAttachments({
    draftId: draft.id,
    initial: draft.attachments,
    closing,
    onToast,
    onFieldsChanged: noteAttachmentsChanged
  })

  const saveAndClose = useCallback(
    (afterClose: () => void) => {
      if (closing || !window.attn) return
      if (isMutating()) {
        onToast('Wait for the current attachment change to finish')
        return
      }
      if (!commitPendingRecipients()) {
        onToast('Enter a valid recipient before closing')
        return
      }
      setClosing(true)
      void saveNow()
        .then(() => window.attn.draft.close(draft.id))
        .then((result) => {
          afterClose()
          onToast(result === 'saved' ? 'Draft saved' : 'Empty draft discarded')
        })
        .catch(() => {
          setClosing(false)
          onToast('Draft could not be saved — retrying')
        })
    },
    [closing, commitPendingRecipients, draft.id, isMutating, onToast, saveNow]
  )
  const closeAndSave = useCallback(() => saveAndClose(onClose), [onClose, saveAndClose])
  const closeAndExit = useCallback(
    (afterExit?: () => void) =>
      saveAndClose(() => {
        const finishExit = onExit ?? onClose
        finishExit()
        afterExit?.()
      }),
    [onClose, onExit, saveAndClose]
  )
  const runComposerKey = useCallback(
    (event: KeyboardEvent): boolean => {
      const command = matchComposerKey(event)
      if (command) {
        command.run()
        return true
      }
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const close = mode === 'inline' ? closeAndExit : closeAndSave
        close()
        return true
      }
      return false
    },
    [closeAndExit, closeAndSave, mode]
  )
  useImperativeHandle(ref, () => ({ exitConversation: closeAndExit }), [closeAndExit])

  const send = useCallback(() => {
    if (closing || !window.attn) return
    setSendError(null)
    if (isMutating()) {
      setSendError('Wait for attachments to finish')
      return
    }
    if (!commitPendingRecipients()) {
      setSendError('Enter a valid recipient before sending')
      return
    }
    setClosing(true)
    void saveNow()
      .then(() => window.attn.outbox.send(draft.id))
      .then((result) => {
        onClose()
        onToast('Sent — Undo (Z)', { expiresAt: result.sendAt, countdown: true })
      })
      .catch((error: unknown) => {
        setClosing(false)
        setSendError(
          errorMessage(error).includes('at least one recipient')
            ? 'Add at least one recipient'
            : 'Message could not be queued — your draft is still here'
        )
      })
  }, [closing, commitPendingRecipients, draft.id, isMutating, onClose, onToast, saveNow])
  const discard = useCallback((): void => {
    if (closing || !window.attn) return
    if (isMutating()) {
      onToast('Wait for the current attachment change to finish')
      return
    }
    setClosing(true)
    void window.attn.draft
      .discard(draft.id)
      .then(() => {
        onClose()
        onToast('Draft discarded')
      })
      .catch(() => {
        setClosing(false)
        onToast('Draft could not be discarded')
      })
  }, [closing, draft.id, isMutating, onClose, onToast])

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!runComposerKey(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runComposerKey])

  return {
    to,
    setTo,
    cc,
    setCc,
    bcc,
    setBcc,
    draggingFiles,
    setDraggingFiles,
    subject,
    setSubject,
    followUpAt,
    setFollowUpAt,
    followUpOpen,
    setFollowUpOpen,
    showCopies,
    setShowCopies,
    closing,
    sendError,
    aiTipReady,
    preparedHtml,
    unifiedSignatureAndQuote,
    unifiedContentExpanded,
    revealUnifiedContent,
    hasPreservedContent,
    notePreservedContent,
    toFieldRef,
    ccFieldRef,
    bccFieldRef,
    captureEditor,
    localRevision,
    savedRevision,
    saveStatus,
    updateFields,
    notePendingRecipientChange,
    noteAiContentSettled,
    handleSnippetInserted,
    attaching,
    addAttachment,
    pickAttachments,
    addDroppedFiles,
    removeAttachment,
    removeLastAttachment,
    visibleAttachments,
    closeAndSave,
    closeAndExit,
    runComposerKey,
    send,
    discard
  }
}
