export function Kbd({
  children,
  compact = false
}: {
  children: React.ReactNode
  compact?: boolean
}): React.JSX.Element {
  return (
    <kbd
      className={`rounded-[5px] border border-edge bg-active py-px font-medium text-ink-dim ${
        compact ? 'px-1 text-[10px]' : 'px-1.5 text-[10.5px]'
      }`}
    >
      {children}
    </kbd>
  )
}
