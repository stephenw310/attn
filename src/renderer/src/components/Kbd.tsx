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
    <kbd
      // The key takes the size of the line it sits in, as a lettered key does;
      // small capitals already set it a little below the surrounding text.
      className={`app-small-caps font-semibold text-accent ${compact ? 'text-[0.86em]' : ''}`}
    >
      {children}
    </kbd>
  )
}
