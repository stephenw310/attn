import { useEffect, useState } from 'react'
import type { ContactSearchResult } from '../../../shared/contacts'
import { CONTACT_AUTOCOMPLETE_DEBOUNCE_MS } from '../tuning'

export function useAutocomplete(query: string): ContactSearchResult[] {
  const [suggestions, setSuggestions] = useState<ContactSearchResult[]>([])

  useEffect(() => {
    if (!window.attn || query.trim().length === 0) {
      setSuggestions([])
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      void window.attn?.contacts
        .search(query)
        .then((results) => {
          if (active) setSuggestions(results)
        })
        .catch(() => {
          if (active) setSuggestions([])
        })
    }, CONTACT_AUTOCOMPLETE_DEBOUNCE_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query])

  return suggestions
}
