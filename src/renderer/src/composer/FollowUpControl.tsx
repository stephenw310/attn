import { useEffect, useMemo, useRef, useState } from 'react'
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
  // popover and dismissing hands it back to the trigger — from where the
  // next Escape reaches the composer's ordinary close handling.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) popoverRef.current?.focus()
    else if (wasOpenRef.current) triggerRef.current?.focus()
    wasOpenRef.current = open
  }, [open])
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`flex h-8 max-w-72 shrink-0 items-center px-1 text-xs underline decoration-current/45 underline-offset-4 ${
          followUpAt !== null ? 'text-accent' : 'text-ink-dim hover:text-ink'
        }`}
        data-testid="composer-follow-up"
        data-follow-up-at={followUpAt ?? undefined}
        aria-expanded={open}
        aria-label="Remind me if no reply"
        title={`Remind me if no reply (${modKeyLabel()}⇧H)`}
        onClick={() => onOpenChange(!open)}
      >
        <span className="truncate">
          {followUpAt !== null ? `Follow up ${formatSnoozeDate(followUpAt)}` : 'Remind me'}
        </span>
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape containment for the transient popover; its buttons and input carry the interactions
        <div
          ref={popoverRef}
          tabIndex={-1}
          className="absolute bottom-full left-0 z-30 mb-2 flex w-72 flex-col gap-1 rounded-lg border border-edge bg-raised p-2 shadow-2xl outline-none"
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
        </div>
      )}
    </div>
  )
}
