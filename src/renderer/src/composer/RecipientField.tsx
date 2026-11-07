import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  isValidEmail,
  type MailAddress,
  normalizeEmailKey,
  parseRecipientInput
} from '../../../shared/address'
import type { ContactSearchResult } from '../../../shared/contacts'
import { isCompleteRecipient, shouldCommitOnComma } from './recipientInput'
import { useAutocomplete } from './useAutocomplete'

interface RecipientFieldProps {
  field: 'to' | 'cc' | 'bcc'
  label: string
  recipients: MailAddress[]
  autoFocus?: boolean
  onChange: (recipients: MailAddress[]) => void
  onPendingChange: () => void
}

function fromContact(contact: ContactSearchResult): MailAddress | null {
  const email = contact.email.trim()
  return isValidEmail(email) ? { name: contact.name.trim(), email } : null
}

export interface RecipientFieldHandle {
  commitPending: (reportInvalid?: boolean) => boolean
  hasRecipients: () => boolean
}

function RecipientChip({
  recipient,
  onRemove
}: {
  recipient: MailAddress
  onRemove: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState(false)
  const select = (element: HTMLButtonElement): void => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    selection?.removeAllRanges()
    selection?.addRange(range)
    setSelected(true)
  }

  return (
    <span
      className={`inline-flex max-w-full items-center rounded bg-active text-xs text-ink ${selected ? 'ring-1 ring-accent' : ''}`}
      data-email={recipient.email}
      data-testid="recipient-chip"
      data-selected={selected ? 'true' : 'false'}
    >
      <button
        type="button"
        className="flex min-w-0 select-all items-center gap-1 rounded-l py-1 pl-2 pr-1 text-left outline-none"
        aria-label={`Select ${recipient.email}`}
        title={recipient.email}
        data-tooltip=""
        data-testid="recipient-select"
        onFocus={(event) => select(event.currentTarget)}
        onClick={(event) => select(event.currentTarget)}
        onBlur={() => setSelected(false)}
        onCopy={(event) => {
          event.clipboardData.setData('text/plain', recipient.email)
          event.preventDefault()
        }}
      >
        {recipient.name && <span className="truncate">{recipient.name}</span>}
        <span className={`truncate ${recipient.name ? 'max-w-40 text-[10px] text-ink-dim' : ''}`}>
          {recipient.name ? `<${recipient.email}>` : recipient.email}
        </span>
      </button>
      <button
        type="button"
        className="shrink-0 select-none rounded-r py-1 pr-2 text-ink-faint hover:text-ink"
        aria-label={`Remove ${recipient.email}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  )
}

export const RecipientField = forwardRef<RecipientFieldHandle, RecipientFieldProps>(function RecipientField(
  { field, label, recipients, autoFocus = false, onChange, onPendingChange },
  ref
): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  // A suggestion wins over typed text only once the user has moved to it. Until
  // then a complete typed address is what Enter commits (review B30).
  const [navigated, setNavigated] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suggestions = useAutocomplete(query).filter(
    (suggestion) =>
      isValidEmail(suggestion.email) && !recipients.some((recipient) => recipient.email === suggestion.email)
  )

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const add = useCallback(
    (next: readonly MailAddress[]): void => {
      const invalidRecipient = next.find((recipient) => !isValidEmail(recipient.email))
      if (invalidRecipient) {
        setInvalid(invalidRecipient.email)
        return
      }
      const seen = new Set(recipients.map((recipient) => normalizeEmailKey(recipient.email)))
      const unique = next.filter((recipient) => !seen.has(normalizeEmailKey(recipient.email)))
      if (unique.length > 0) onChange([...recipients, ...unique])
      setQuery('')
      setInvalid(null)
    },
    [onChange, recipients]
  )

  const commit = useCallback(
    (reportInvalid = true): boolean => {
      if (query.trim().length === 0) return true
      const parsed = parseRecipientInput(query)
      if (parsed.invalid.length > 0 || parsed.recipients.length === 0) {
        if (reportInvalid) setInvalid(query.trim())
        return false
      }
      add(parsed.recipients)
      return true
    },
    [add, query]
  )

  useImperativeHandle(
    ref,
    () => ({
      commitPending: commit,
      hasRecipients: () => recipients.length > 0 || parseRecipientInput(query).recipients.length > 0
    }),
    [commit, recipients, query]
  )

  return (
    <div
      className="relative flex min-h-11 items-start px-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-edge focus-within:after:border-accent"
      data-testid={`composer-${field}`}
    >
      <span className="w-12 shrink-0 pt-3 text-xs font-normal text-ink-dim">{label}</span>
      <div
        className={`flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5 ${field === 'to' ? 'pr-16' : ''}`}
      >
        {recipients.map((recipient) => (
          <RecipientChip
            key={recipient.email}
            recipient={recipient}
            onRemove={() => onChange(recipients.filter((candidate) => candidate.email !== recipient.email))}
          />
        ))}
        <input
          ref={inputRef}
          className="min-w-28 flex-1 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-ink-faint"
          aria-invalid={invalid ? 'true' : undefined}
          aria-label={`${label} recipients`}
          value={query}
          onBlur={() => commit()}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlighted(0)
            setNavigated(false)
            setInvalid(null)
            onPendingChange()
          }}
          onKeyDown={(event) => {
            const suggestion =
              (navigated || !isCompleteRecipient(query)) && suggestions[highlighted]
                ? suggestions[highlighted]
                : null
            if (event.key === 'ArrowDown' && suggestions.length > 0) {
              event.preventDefault()
              setNavigated(true)
              setHighlighted((index) => Math.min(index + 1, suggestions.length - 1))
            } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
              event.preventDefault()
              setNavigated(true)
              setHighlighted((index) => Math.max(index - 1, 0))
            } else if ((event.key === 'Enter' || event.key === 'Tab') && suggestion) {
              event.preventDefault()
              const recipient = fromContact(suggestion)
              if (recipient) add([recipient])
            } else if (
              event.key === 'Enter' ||
              (event.key === ',' &&
                shouldCommitOnComma(query, event.currentTarget.selectionStart ?? query.length))
            ) {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && query.length === 0 && recipients.length > 0) {
              onChange(recipients.slice(0, -1))
            }
          }}
        />
      </div>

      {invalid && (
        <div className="absolute left-13 top-full z-20 mt-1 rounded-md bg-danger px-2 py-1 text-[11px] text-on-danger">
          {invalid} is not a valid email address
        </div>
      )}

      {suggestions.length > 0 && query.trim() && !invalid && (
        <div className="absolute left-12 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-edge bg-raised shadow-menu">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.email}
              type="button"
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
                index === highlighted ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active'
              }`}
              data-testid="autocomplete-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const recipient = fromContact(suggestion)
                if (recipient) add([recipient])
                inputRef.current?.focus()
              }}
            >
              <span className="font-medium text-ink">{suggestion.name}</span>
              <span className="truncate text-xs text-ink-faint">{suggestion.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
