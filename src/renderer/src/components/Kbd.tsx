export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[5px] border border-edge bg-active px-1.5 py-px text-[10.5px] font-medium text-ink-dim">
      {children}
    </kbd>
  )
}
