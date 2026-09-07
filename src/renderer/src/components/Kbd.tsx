/**
 * A key, lettered rather than boxed. The shortcut hints in the footer, the
 * sidebar and the menus all read as marginalia in red, which keeps a row of
 * them from fencing off the text beside it.
 */
export function Kbd({
  children,
  compact = false
}: {
  children: React.ReactNode
  compact?: boolean
}): React.JSX.Element {
  return (
    <kbd className={`app-small-caps font-semibold text-accent ${compact ? 'text-[11px]' : 'text-[11.5px]'}`}>
      {children}
    </kbd>
  )
}
