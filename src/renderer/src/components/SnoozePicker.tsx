import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSnoozeDate, parseSnoozeText, snoozePresets } from '../../../shared/snooze'

interface SnoozePickerProps {
  targetCount: number
  onCancel: () => void
  onConfirm: (dueAt: number) => void
  onUnsnooze?: () => void
}

export function SnoozePicker(props: SnoozePickerProps): React.JSX.Element {
  const { targetCount, onCancel, onConfirm, onUnsnooze } = props
  const [custom, setCustom] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useRef<HTMLElement | null>(null)
  const presets = useMemo(() => snoozePresets(), [])
  const parsedCustom = useMemo(() => parseSnoozeText(custom), [custom])
  const customDueAt = parsedCustom !== null && parsedCustom > Date.now() ? parsedCustom : null
  const optionCount = presets.length + (onUnsnooze ? 1 : 0)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const runActiveOption = (): void => {
    const preset = presets[activeIndex]
    if (preset) onConfirm(preset.dueAt)
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
        aria-labelledby="snooze-title"
        data-testid="snooze-picker"
        tabIndex={-1}
        className="fixed top-1/2 left-1/2 z-[60] w-[min(430px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-raised p-3 shadow-dialog focus:outline-none"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.currentTarget.focus()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((index) => (index + direction + optionCount) % optionCount)
            return
          }
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault()
            runActiveOption()
          }
        }}
      >
        <div className="px-2 pt-1 pb-2">
          <h2 id="snooze-title" className="text-base font-semibold">
            Remind me later
          </h2>
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
              className={`flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${
                activeIndex === index ? 'bg-active text-ink' : ''
              }`}
              onClick={() => onConfirm(preset.dueAt)}
              onMouseMove={() => setActiveIndex(index)}
            >
              <span>{preset.label}</span>
              <span className="text-xs text-ink-faint">{formatSnoozeDate(preset.dueAt)}</span>
            </button>
          ))}
        </div>
        {onUnsnooze && (
          <div className="mt-2 border-t border-edge pt-2">
            <button
              type="button"
              data-testid="snooze-unsnooze"
              data-active={activeIndex === presets.length || undefined}
              tabIndex={-1}
              className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${
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
        <div className="mt-2 border-t border-edge px-2 pt-3 pb-1">
          <label htmlFor="snooze-custom" className="text-xs font-medium text-ink-dim">
            Custom time
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="snooze-custom"
              data-testid="snooze-input"
              value={custom}
              placeholder="thu 2pm or in 3 days"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-ground px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancel()
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  if (customDueAt !== null) onConfirm(customDueAt)
                }
              }}
            />
            <button
              type="button"
              data-testid="snooze-custom-confirm"
              disabled={customDueAt === null}
              className="cursor-pointer rounded-lg bg-accent px-3 text-sm font-semibold text-ground disabled:cursor-default disabled:opacity-35"
              onClick={() => customDueAt !== null && onConfirm(customDueAt)}
            >
              Snooze
            </button>
          </div>
          <div data-testid="snooze-resolved" className="mt-1.5 min-h-4 text-xs text-ink-faint">
            {parsedCustom !== null &&
              (customDueAt !== null ? formatSnoozeDate(customDueAt) : 'Choose a future time')}
          </div>
        </div>
      </section>
    </>
  )
}
