export function Kbd({
  children,
  compact = false
}: {
  children: React.ReactNode
  compact?: boolean
}): React.JSX.Element {
  return <kbd className={`app-keycap${compact ? ' app-keycap-compact' : ''}`}>{children}</kbd>
}
