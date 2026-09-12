import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../components/Button'
import { Kbd } from '../components/Kbd'
import { modKeyLabel } from '../platform'

export function SubjectConfirmation({
  onCancel,
  onSend
}: {
  onCancel: () => void
  onSend: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    titleRef.current?.focus()
    return () => {
      dialog?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return createPortal(
    <dialog
      ref={dialogRef}
      data-testid="no-subject-confirmation"
      data-composer-transient
      aria-labelledby="no-subject-title"
      className="m-auto w-[min(420px,90vw)] rounded-lg border border-edge bg-raised p-6 text-ink shadow-dialog backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          event.preventDefault()
          if (!event.repeat) onSend()
        }
      }}
    >
      <h2 ref={titleRef} tabIndex={-1} id="no-subject-title" className="text-base font-semibold outline-none">
        Send without a subject?
      </h2>
      <p className="mt-3 text-sm text-ink-dim">
        This message has no subject. You can add one or send it as it is.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="app-button" onClick={onCancel}>
          Keep editing <Kbd>Esc</Kbd>
        </button>
        <Button variant="primary" onClick={onSend}>
          Send without subject <Kbd>{modKeyLabel()} Enter</Kbd>
        </Button>
      </div>
    </dialog>,
    document.body
  )
}
