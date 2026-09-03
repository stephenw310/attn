import type { Locator, Page } from '@playwright/test'
import { expect } from './electron'

// Shared ways of driving the app's own navigation surfaces (R14): the G
// chords, the command palette, and the list selection every triage spec reads.

/** Press a G chord, e.g. `goTo(page, 'a')` for All Mail. */
export async function goTo(page: Page, chordKey: string): Promise<void> {
  await page.keyboard.press('g')
  await page.keyboard.press(chordKey)
}

/** The seeded thread row carrying `subject`. */
export function threadRow(page: Page, subject: string): Locator {
  return page.getByTestId('thread-row').filter({ hasText: subject })
}

/** Index of the selected row in the list, or -1 when nothing is selected. */
export function selectedIndex(page: Page): Promise<number> {
  return page
    .getByTestId('thread-row')
    .evaluateAll((rows) => rows.findIndex((row) => row.hasAttribute('data-selected')))
}

/**
 * Open the palette and, when given, type a query.
 *
 * The shortcut is a window-level listener that mounts with the app shell, so a
 * Mod+K pressed a beat too early is simply dropped. Re-pressing is safe —
 * `palette.open` always opens and resets the palette, it never toggles it shut
 * — so the press is retried until the palette is actually up rather than
 * pressed once against a view that may not be listening yet.
 */
export async function openPalette(page: Page, query = ''): Promise<void> {
  const input = page.getByTestId('command-palette-input')
  await expect
    .poll(async () => {
      if ((await input.count()) === 0) await page.keyboard.press('ControlOrMeta+K')
      return input.count()
    })
    .toBe(1)
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await expect(input).toBeFocused()
  if (query) await input.fill(query)
}

/** Open the palette, run the first result for `query`, and wait for it to close. */
export async function runPaletteCommand(page: Page, query: string): Promise<void> {
  await openPalette(page, query)
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

/** Consent to AI writing through the real bridge, key custody included (F17). */
export async function enableAi(page: Page, autocomplete = false): Promise<void> {
  await page.evaluate(async (auto) => {
    await window.attn.ai.setKey('sk-e2e-test')
    await window.attn.ai.setSetting('enabled', true)
    if (auto) await window.attn.ai.setSetting('autocompleteEnabled', true)
  }, autocomplete)
}
