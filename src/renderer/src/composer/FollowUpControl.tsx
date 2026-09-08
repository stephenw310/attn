import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatSnoozeDate, parseSnoozeText } from '../../../shared/snooze'
import { modKeyLabel } from '../platform'

/**
 * "Remind me if no reply" (T35/F9): the chosen deadline rides the draft's
 * outbox row; the reminder is created only when the send commits. Shares the
 * snooze natural-language parser for the custom field.
 */
export function FollowUpControl({
  followUpAt,
  onChange,
  open,
  onOpenChange
}: {
  followUpAt: number | null
  onChange: (value: number | null) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const parsedCustom = useMemo(() => (custom.trim() ? parseSnoozeText(custom) : null), [custom])
  const customValid = parsedCustom !== null && parsedCustom > Date.now()
  const choose = (value: number | null): void => {
    onChange(value)
    onOpenChange(false)
    setCustom('')
  }
  const preset = (days: number): number => Date.now() + days * 24 * 60 * 60 * 1000
  // Focus follows the popover (PR #101 review): its Escape containment only
  // sees the key when focus is inside, so opening moves focus onto the
  // popover. Escape and selection return focus to the trigger, from where the
  // next Escape closes the composer. Outside clicks keep their chosen focus.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const restoreTriggerFocus = useRef(true)
  const [position, setPosition] = useState({ right: 12, bottom: 12 })
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          right: Math.max(12, Math.min(window.innerWidth - 300, window.innerWidth - rect.right)),
          bottom: Math.max(12, Math.min(window.innerHeight - 160, window.innerHeight - rect.top + 8))
        })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        restoreTriggerFocus.current = false
        onOpenChange(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, onOpenChange])
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      restoreTriggerFocus.current = true
      popoverRef.current?.focus()
    } else if (wasOpenRef.current && restoreTriggerFocus.current) triggerRef.current?.focus()
    wasOpenRef.current = open
  }, [open])
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-active ${
          followUpAt !== null ? 'text-accent' : 'text-ink-dim hover:text-ink'
        }`}
        data-testid="composer-follow-up"
        data-follow-up-at={followUpAt ?? undefined}
        aria-expanded={open}
        aria-label="Remind me if no reply"
        data-tooltip={`Remind me if no reply (${modKeyLabel()}⇧H)`}
        onClick={() => onOpenChange(!open)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4 fill-none stroke-current"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {followUpAt !== null && <span className="max-w-40 truncate">{formatSnoozeDate(followUpAt)}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            tabIndex={-1}
            role="dialog"
            aria-label="Remind me if no reply"
            style={{ ...position, maxHeight: `calc(100vh - ${position.bottom + 12}px)` }}
            className="fixed z-[100] flex w-72 max-w-[calc(100vw-24px)] flex-col gap-1 overflow-y-auto rounded-lg border border-edge bg-raised p-2 shadow-2xl outline-none"
            data-composer-transient
            data-testid="follow-up-popover"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              onOpenChange(false)
            }}
          >
            <p className="px-1 text-[11px] text-ink-faint">
              If nobody replies by the deadline, the thread resurfaces in your inbox.
            </p>
            <button
              type="button"
              className="cursor-pointer rounded-md px-2 py-1.5 text-left text-xs text-ink-dim hover:bg-active hover:text-ink"
              data-testid="follow-up-preset-3d"
              onClick={() => choose(preset(3))}
            >
              In 3 days
            </button>
            <button
              type="button"
              className="cursor-pointer rounded-md px-2 py-1.5 text-left text-xs text-ink-dim hover:bg-active hover:text-ink"
              data-testid="follow-up-preset-1w"
              onClick={() => choose(preset(7))}
            >
              In 1 week
            </button>
            <div className="flex items-center gap-1.5 px-1 pt-1">
              <input
                className="h-8 min-w-0 flex-1 rounded-md border border-edge bg-canvas px-2 text-xs text-ink outline-none focus:border-accent"
                data-testid="follow-up-custom-input"
                aria-label="Custom follow-up deadline"
                placeholder="e.g. next Friday"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !customValid || parsedCustom === null) return
                  event.preventDefault()
                  event.stopPropagation()
                  choose(parsedCustom)
                }}
              />
              <button
                type="button"
                className="h-8 rounded-md bg-accent/20 px-2.5 text-xs font-semibold text-accent disabled:opacity-45"
                data-testid="follow-up-custom-confirm"
                disabled={!customValid}
                onClick={() => parsedCustom !== null && choose(parsedCustom)}
              >
                Set
              </button>
            </div>
            {custom.trim() !== '' && (
              <p className="px-1 text-[11px] text-ink-faint" data-testid="follow-up-resolved">
                {customValid && parsedCustom !== null ? formatSnoozeDate(parsedCustom) : 'Pick a future time'}
              </p>
            )}
            {followUpAt !== null && (
              <button
                type="button"
                className="cursor-pointer rounded-md px-2 py-1.5 text-left text-xs text-ink-faint hover:bg-active hover:text-ink"
                data-testid="follow-up-clear"
                onClick={() => choose(null)}
              >
                Don't remind me
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
