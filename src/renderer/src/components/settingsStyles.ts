/**
 * The class strings the settings surface shares (F15, T32). They were copied
 * verbatim across the settings view, the AI section and the snippet manager;
 * one definition is what keeps a control looking the same wherever it appears.
 */

/** One label / control pair, on its own row. */
export const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 px-3 py-2.5'
/** The explanatory paragraph under a setting's title. */
export const NOTE = 'text-[13px] leading-[1.55] text-ink-dim'
export const SECTION_TITLE = 'app-small-caps text-[14px] text-accent'
/* A value on a ruled line, not a control in a box. */
export const SELECT =
  'min-w-0 max-w-[min(21rem,45vw)] cursor-pointer border-b border-edge bg-transparent px-1 py-1 text-[15.5px] text-ink outline-none focus:border-accent'
export const INPUT =
  'border-b border-edge bg-transparent px-1 py-1 text-[15.5px] text-ink outline-none focus:border-accent'
/** A secondary button beside a setting: Reconnect, Remove, Move up. */
export const ACTION_BUTTON =
  'cursor-pointer whitespace-nowrap px-1 py-1 text-[15.5px] text-ink-dim underline decoration-1 underline-offset-4 hover:text-ink disabled:cursor-default disabled:opacity-45'
