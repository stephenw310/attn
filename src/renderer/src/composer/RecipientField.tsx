import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { isValidEmail, type MailAddress, parseRecipientInput } from '../../../shared/address'
import type { ContactSearchResult } from '../../../shared/contacts'
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
}

export const RecipientField = forwardRef<RecipientFieldHandle, RecipientFieldProps>(function RecipientField(
  { field, label, recipients, autoFocus = false, onChange, onPendingChange },
  ref
): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
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
      const seen = new Set(recipients.map((recipient) => recipient.email.toLowerCase()))
      const unique = next.filter((recipient) => !seen.has(recipient.email.toLowerCase()))
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

  useImperativeHandle(ref, () => ({ commitPending: commit }), [commit])

  return (
    <div
      className="relative flex min-h-10 items-start border-b border-edge px-4"
      data-testid={`composer-${field}`}
    >
      <span className="w-10 shrink-0 pt-2.5 text-sm font-medium text-ink-faint">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5">
        {recipients.map((recipient) => (
          <span
            key={recipient.email}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-edge bg-active px-2 py-1 text-xs text-ink"
            data-email={recipient.email}
            data-testid="recipient-chip"
          >
            <span className="truncate">{recipient.name || recipient.email}</span>
            <button
              type="button"
              className="text-ink-faint hover:text-ink"
              aria-label={`Remove ${recipient.email}`}
              onClick={() => onChange(recipients.filter((candidate) => candidate.email !== recipient.email))}
            >
              ×
            </button>
          </span>
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
            setInvalid(null)
            onPendingChange()
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && suggestions.length > 0) {
              event.preventDefault()
              setHighlighted((index) => Math.min(index + 1, suggestions.length - 1))
            } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
              event.preventDefault()
              setHighlighted((index) => Math.max(index - 1, 0))
            } else if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[highlighted]) {
              event.preventDefault()
              const recipient = fromContact(suggestions[highlighted])
              if (recipient) add([recipient])
            } else if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && query.length === 0 && recipients.length > 0) {
              onChange(recipients.slice(0, -1))
            }
          }}
        />
      </div>

      {invalid && (
        <div className="absolute left-13 top-full z-20 mt-1 rounded-md bg-danger px-2 py-1 text-[11px] text-white">
          {invalid} is not a valid email address
        </div>
      )}

      {suggestions.length > 0 && query.trim() && !invalid && (
        <div className="absolute left-12 right-4 top-full z-10 mt-1 overflow-hidden rounded-lg border border-edge bg-raised shadow-2xl">
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
