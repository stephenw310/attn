import { useEffect, useRef, useState } from 'react'
import type { SendAsIdentity } from '../../../shared/drafts'

export function SenderMenu({
  identities,
  email,
  disabled,
  triggerRef,
  onChange
}: {
  identities: SendAsIdentity[]
  email: string
  disabled: boolean
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onChange: (email: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLFieldSetElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const options = identities.some((identity) => identity.sendAsEmail === email)
    ? identities
    : [{ sendAsEmail: email, displayName: '' }, ...identities]
  const selected = options.find((identity) => identity.sendAsEmail === email)

  const selectedIndex = Math.max(
    0,
    options.findIndex((identity) => identity.sendAsEmail === email)
  )

  useEffect(() => {
    if (!open) return
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    items?.[selectedIndex]?.focus()
    const onDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, selectedIndex])

  return (
    <fieldset
      ref={wrapRef}
      aria-label="Sender"
      className="relative min-w-0 flex-1"
      data-composer-transient={open ? '' : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="From"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="composer-from-select"
        disabled={disabled}
        className="flex max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-dim outline-none hover:bg-active hover:text-ink focus-visible:bg-active focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="truncate">
          {selected?.displayName && <span className="mr-1.5 text-ink">{selected.displayName}</span>}
          {email}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="size-3 shrink-0 text-ink-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <title>Choose sender</title>
          <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sender address"
          data-testid="composer-from-menu"
          className="absolute top-full left-0 z-50 mt-1 max-h-64 w-80 max-w-full overflow-y-auto rounded-lg border border-edge bg-raised p-1.5 shadow-menu"
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
            ]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            let next: number
            if (event.key === 'ArrowDown') next = (index + 1) % items.length
            else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = items.length - 1
            else return
            event.preventDefault()
            event.stopPropagation()
            items[next]?.focus()
          }}
        >
          {options.map((identity) => (
            <button
              key={identity.sendAsEmail}
              type="button"
              role="menuitemradio"
              aria-checked={identity.sendAsEmail === email}
              tabIndex={-1}
              data-testid="composer-from-option"
              data-email={identity.sendAsEmail}
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left outline-none hover:bg-active focus:bg-active"
              onClick={() => {
                onChange(identity.sendAsEmail)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <span className="min-w-0 flex-1">
                {identity.displayName && (
                  <span className="block truncate text-xs font-medium text-ink">{identity.displayName}</span>
                )}
                <span className="block truncate text-xs text-ink-dim">{identity.sendAsEmail}</span>
              </span>
              <span aria-hidden className="w-3 shrink-0 text-xs text-accent">
                {identity.sendAsEmail === email ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </fieldset>
  )
}
