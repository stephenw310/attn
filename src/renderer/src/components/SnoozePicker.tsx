import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSnoozeDate, parseSnoozeText, snoozePresets } from '../../../shared/snooze'
import { wrappedIndex } from '../hooks/useHighlightedOption'
import { PickerHeading, PickerLegend } from './PickerChrome'

interface SnoozePickerProps {
  targetCount: number
  onCancel: () => void
  onConfirm: (dueAt: number) => void
  onUnsnooze?: () => void
}

export function SnoozePicker(props: SnoozePickerProps): React.JSX.Element {
  const { targetCount, onCancel, onConfirm, onUnsnooze } = props
  const [custom, setCustom] = useState('')
  const [expired, setExpired] = useState(false)
  const confirm = (dueAt: number): void => {
    if (!Number.isFinite(dueAt) || dueAt <= Date.now()) {
      setExpired(true)
      return
    }
    onConfirm(dueAt)
  }
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useRef<HTMLElement | null>(null)
  const presets = useMemo(() => snoozePresets(), [])
  const parsedCustom = useMemo(() => parseSnoozeText(custom), [custom])
  const customDueAt = parsedCustom !== null && parsedCustom > Date.now() ? parsedCustom : null
  const optionCount = presets.length + (onUnsnooze ? 1 : 0)

  useEffect(() => {
    const previous = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const runActiveOption = (): void => {
    const preset = presets[activeIndex]
    if (preset) confirm(preset.dueAt)
    else if (onUnsnooze) onUnsnooze()
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the app-level picker guard */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is the pointer dismissal path */}
      <div className="fixed inset-0 z-50 bg-overlay" onClick={onCancel} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Snooze"
        data-testid="snooze-picker"
        tabIndex={-1}
        className="fixed top-[12vh] left-1/2 z-[60] flex max-h-[80vh] w-[min(540px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-dialog-edge bg-raised shadow-dialog focus:outline-none"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Tab') {
            event.preventDefault()
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'input, button:not(:disabled):not([tabindex="-1"])'
              )
            )
            const current = controls.indexOf(document.activeElement as HTMLElement)
            controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.currentTarget.focus()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((index) => wrappedIndex(index, direction, optionCount))
            return
          }
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault()
            runActiveOption()
          }
        }}
      >
        <PickerHeading title="Snooze" onClose={onCancel} />
        <div className="min-h-0 overflow-y-auto px-3 pb-6">
          <div className="px-3 pb-4">
            <p data-testid="snooze-subtitle" className="mt-0.5 text-xs text-ink-faint">
              {targetCount > 1
                ? `Choose when these ${targetCount} conversations return.`
                : 'Choose when this conversation returns.'}
            </p>
          </div>
          <div className="flex flex-col gap-0.5">
            {presets.map((preset, index) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`snooze-preset-${preset.id}`}
                data-active={activeIndex === index || undefined}
                tabIndex={-1}
                className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-3 text-left text-[13px] ${
                  activeIndex === index ? 'bg-active text-ink' : ''
                }`}
                onClick={() => confirm(preset.dueAt)}
                onMouseMove={() => setActiveIndex(index)}
              >
                <span>{preset.label}</span>
                <span className="text-xs text-ink-faint">{formatSnoozeDate(preset.dueAt)}</span>
              </button>
            ))}
          </div>
          {onUnsnooze && (
            <div className="mt-2 border-t border-dialog-edge pt-2">
              <button
                type="button"
                data-testid="snooze-unsnooze"
                data-active={activeIndex === presets.length || undefined}
                tabIndex={-1}
                className={`flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-3 text-left text-[13px] ${
                  activeIndex === presets.length ? 'bg-active text-ink' : ''
                }`}
                onClick={onUnsnooze}
                onMouseMove={() => setActiveIndex(presets.length)}
              >
                <span>Unsnooze</span>
                <span className="text-xs text-ink-faint">Return to inbox now</span>
              </button>
            </div>
          )}
          <div className="mt-5 px-3 pt-3 pb-1">
            <label htmlFor="snooze-custom" className="text-xs font-medium text-ink-dim">
              Custom time
            </label>
            <div className="mt-1.5 flex flex-col gap-4">
              <input
                id="snooze-custom"
                aria-describedby="snooze-resolved"
                aria-invalid={Boolean(custom.trim() && customDueAt === null)}
                data-testid="snooze-input"
                value={custom}
                placeholder="thu 2pm or in 3 days"
                className="min-w-0 flex-1 rounded-lg border border-dialog-edge bg-ground px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                onChange={(event) => {
                  setExpired(false)
                  setCustom(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    onCancel()
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (customDueAt !== null) confirm(customDueAt)
                  }
                }}
              />
              <button
                type="button"
                data-testid="snooze-custom-confirm"
                disabled={customDueAt === null}
                className="cursor-pointer rounded-lg bg-accent self-start px-4 py-2 text-[13px] font-medium text-on-accent disabled:cursor-default disabled:opacity-35"
                onClick={() => customDueAt !== null && confirm(customDueAt)}
              >
                Snooze
              </button>
            </div>
            <div
              id="snooze-resolved"
              role="status"
              data-testid="snooze-resolved"
              className="mt-1.5 min-h-4 text-xs text-ink-faint"
            >
              {expired && 'Choose a future time. This time has already passed.'}
              {!expired &&
                parsedCustom !== null &&
                (customDueAt !== null ? formatSnoozeDate(customDueAt) : 'Choose a future time')}
              {custom.trim() && parsedCustom === null && 'Enter a time such as “thu 2pm” or “in 3 days”.'}
            </div>
          </div>
        </div>
        <PickerLegend />
      </section>
    </>
  )
}
