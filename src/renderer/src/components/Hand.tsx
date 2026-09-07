import { useEffect, useId, useRef } from 'react'
import { HAND_WIDTH, sealPath, tornRulePath, tornStripPath } from '../hand'
import { paintPaper, readPaperPalette } from '../paper'

/** Repaint the sheet at most this often while a window is being dragged. */
const REPAINT_DELAY_MS = 160

/**
 * The vellum the mail chrome is written on. One fixed canvas behind the whole
 * window, repainted when the theme changes, when the sidebar opens or closes,
 * and after a resize settles.
 */
export function PaperSheet({ bandWidth }: { bandWidth: number }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let timer: number | undefined
    const paint = (): void => {
      const context = canvas.getContext('2d')
      if (!context) return
      // One device pixel per CSS pixel. The texture is noise, not type, and a
      // window-sized canvas at a retina ratio costs four times the memory.
      const width = Math.max(1, Math.round(canvas.clientWidth))
      const height = Math.max(1, Math.round(canvas.clientHeight))
      canvas.width = width
      canvas.height = height
      paintPaper(context, readPaperPalette(document.documentElement), width, height, bandWidth)
    }
    const repaintLater = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(paint, REPAINT_DELAY_MS)
    }
    paint()
    window.addEventListener('resize', repaintLater)
    // The palette lives in the stylesheet, so the sheet follows the attribute
    // the theme writes rather than the React value behind it.
    const themeWatch = new MutationObserver(paint)
    themeWatch.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', repaintLater)
      themeWatch.disconnect()
    }
  }, [bandWidth])

  return <canvas ref={canvasRef} data-testid="paper-sheet" className="app-paper" />
}

/**
 * A rule drawn by hand. It stretches to the width of its container, which
 * squashes the wobble horizontally and leaves the drawn edge intact. An SVG is
 * a replaced element, so it carries its own width rather than taking one from
 * `left` and `right`; place it inside a positioned span instead.
 */
export function TornRule({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${HAND_WIDTH} 3`}
      preserveAspectRatio="none"
      className={`h-[3px] w-full ${className}`}
    >
      <path className="app-hand-rule" d={tornRulePath()} />
    </svg>
  )
}

/**
 * The torn strip of wash that marks the row the keyboard is on. It sits inside
 * the row, so it travels with the row's own exit and shift animations.
 */
export function TornStrip(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${HAND_WIDTH} 100`}
      preserveAspectRatio="none"
      data-testid="thread-selection-strip"
      className="pointer-events-none absolute inset-0 -z-10 size-full"
    >
      <path className="app-hand-wash" d={tornStripPath()} />
    </svg>
  )
}

/**
 * The wax seal beside the wordmark. The ring and the letter are cut out of the
 * wax rather than drawn on it, which is what a stamp does. The mask paints in
 * black and white because those are alpha channels, not palette colors.
 */
export function Seal({ letter }: { letter: string }): React.JSX.Element {
  const maskId = useId()
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 32 32"
      data-testid="wordmark-seal"
      className="app-seal size-[26px] flex-none"
    >
      <mask id={maskId}>
        <path d={sealPath()} fill="#ffffff" />
        <circle cx="16" cy="16" r="12.2" fill="none" stroke="#000000" strokeWidth="1.3" />
        <text
          x="16"
          y="16"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="17"
          fontWeight="500"
          fill="#000000"
          className="font-gotisch"
        >
          {letter}
        </text>
      </mask>
      <rect width="32" height="32" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  )
}
