/**
 * The class strings the settings surface shares (F15, T32). They were copied
 * verbatim across the settings view, the AI section and the snippet manager;
 * one definition is what keeps a control looking the same wherever it appears.
 */

/** One label / control pair, on its own row. */
export const ROW =
  'app-setting-row grid min-h-[83px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[26px] gap-y-2 border-b border-edge py-[17px]'
/** The explanatory paragraph under a setting's title. */
export const NOTE = 'mt-1 max-w-[340px] text-[11px] leading-[1.6] text-ink-dim'
export const SECTION_TITLE = 'mb-[13px] text-[23px] font-[450] tracking-tight text-ink'
export const SELECT =
  'min-w-0 max-w-[min(21rem,45vw)] cursor-pointer rounded-md border border-edge bg-ground px-2.5 py-2 text-[11px] text-ink outline-none focus:border-accent'
export const INPUT =
  'rounded-md border border-edge bg-ground px-2.5 py-2 text-[11px] text-ink outline-none focus:border-accent'
/** A secondary button beside a setting: Reconnect, Remove, Move up. */
export const ACTION_BUTTON =
  'cursor-pointer whitespace-nowrap rounded-md border border-edge px-2.5 py-2 text-[11px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'
