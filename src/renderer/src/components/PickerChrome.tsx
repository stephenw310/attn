import { Kbd } from './Kbd'

export function PickerHeading({ title, onClose }: { title: string; onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-none items-center justify-between gap-4 px-6 pt-6 pb-4">
      <h2 className="text-base font-medium text-ink">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] text-ink-dim hover:text-ink"
      >
        Close <Kbd>Esc</Kbd>
      </button>
    </div>
  )
}

export function PickerLegend({ action = 'Choose' }: { action?: string }): React.JSX.Element {
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-6 gap-y-2 border-t border-dialog-edge bg-ground px-6 py-3 text-[11px] text-ink-dim">
      <span className="flex items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> Navigate
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>Enter</Kbd> {action}
      </span>
    </div>
  )
}
