import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_DELAY_MS } from '../tuning'

export function QuickTooltip(): React.JSX.Element | null {
  const id = useId()
  const [hint, setHint] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let active: HTMLElement | null = null
    const hide = (): void => {
      clearTimeout(timer)
      if (active?.getAttribute('aria-describedby') === id) active.removeAttribute('aria-describedby')
      active = null
      setHint(null)
    }
    const show = (event: Event): void => {
      const element =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-tooltip], button[aria-label]')
          : null
      if (element === active && event.type !== 'focusin') return
      hide()
      if (!element) return
      const text = element.dataset.tooltip ?? element.getAttribute('aria-label')
      if (!text) return
      active = element
      const reveal = (): void => {
        if (!element.isConnected) {
          hide()
          return
        }
        const rect = element.getBoundingClientRect()
        const above = rect.top > 48
        if (!element.hasAttribute('aria-describedby')) element.setAttribute('aria-describedby', id)
        setHint({
          text,
          x: Math.max(164, Math.min(window.innerWidth - 164, rect.x + rect.width / 2)),
          y: above ? rect.top - 8 : rect.bottom + 8,
          above
        })
      }
      if (event.type === 'focusin') reveal()
      else timer = setTimeout(reveal, TOOLTIP_DELAY_MS)
    }
    const leave = (event: Event): void => {
      if (event instanceof MouseEvent && active?.contains(event.relatedTarget as Node | null)) return
      hide()
    }
    document.addEventListener('pointerover', show)
    document.addEventListener('pointerout', leave)
    document.addEventListener('focusin', show)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', show)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('focusin', show)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [id])
  return hint
    ? createPortal(
        <div
          id={id}
          role="tooltip"
          data-testid="quick-tooltip"
          className="pointer-events-none fixed z-[1000] max-w-80 rounded-md border border-edge bg-raised px-2.5 py-1.5 text-xs text-ink shadow-menu"
          style={{ left: hint.x, top: hint.y, transform: `translate(-50%, ${hint.above ? '-100%' : '0'})` }}
        >
          {hint.text}
        </div>,
        document.body
      )
    : null
}
