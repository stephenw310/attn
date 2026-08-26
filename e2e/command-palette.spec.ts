import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

const G_CHORD_COMMANDS = [
  'view.inbox',
  'view.allMail',
  'view.sent',
  'view.starred',
  'view.snoozed',
  'view.drafts',
  'view.spam',
  'view.trash',
  'view.outbox'
] as const

async function openPalette(page: Page, query = ''): Promise<void> {
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
  if (query) await page.getByTestId('command-palette-input').fill(query)
}

async function runPaletteCommand(page: Page, query: string): Promise<void> {
  await openPalette(page, query)
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

test('opens in list, reader, and composer contexts and dispatches a command in each', async ({
  page
}, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await openPalette(page)
  await expect(page.getByTestId('command-palette')).toHaveAttribute('data-usage-loaded', 'true')
  for (const id of G_CHORD_COMMANDS) {
    await expect(page.locator(`[data-command-id="${id}"]`)).toHaveCount(1)
  }

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'palette.png')
  await page.screenshot({ path })
  await testInfo.attach('palette', { path, contentType: 'image/png' })

  await page.getByTestId('command-palette-input').fill('Go to Sent')
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('view-title')).toHaveText('Sent')

  await runPaletteCommand(page, 'Go to Inbox')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()

  await runPaletteCommand(page, 'Reply all')
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()

  await runPaletteCommand(page, 'Discard draft')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
})

test('runs an inline snooze argument through the palette', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await openPalette(page, 'remind me tomorrow 9am')
  const result = page.locator('[data-command-id="triage.snooze"]')
  await expect(result).toContainText('Snooze until')
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await expect(page.getByTestId('toast')).toHaveText('Snoozed')
})

test('keeps focus and keyboard commands inside the open palette', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await openPalette(page)
  const palette = page.getByTestId('command-palette')
  const input = page.getByTestId('command-palette-input')

  await page.keyboard.press('ControlOrMeta+B')
  await expect(page.getByTestId('mail-sidebar')).toBeVisible()
  await expect(input).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  await openPalette(page)
  await page.getByTestId('thread-row').first().focus()
  await page.keyboard.press('e')
  await expect(input).toBeFocused()
  await expect(palette).toBeVisible()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
})

test('opens from the composer quoted-history iframe', async ({ page }) => {
  await page.getByTestId('thread-subject').getByText('This week in focus', { exact: true }).click()
  await page.keyboard.press('f')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await page.getByTestId('composer-quote-toggle').click()
  const quoteBody = page.frameLocator('[data-testid="composer-quote"]').locator('body')
  await quoteBody.focus()
  await quoteBody.press('ControlOrMeta+K')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
})

test('protects an active draft and restores its editor focus after palette dismissal', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.click()
  await composer.typeBody('Keep this draft')

  await openPalette(page)
  await expect(page.locator('[data-command-id="composer.new"]')).toHaveCount(0)
  await expect(page.locator('[data-command-id="search.open"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(composer.editor).toBeFocused()
  await page.keyboard.type(' after Escape')
  await expect(composer.editor).toContainText('Keep this draft after Escape')

  await openPalette(page)
  await page.getByTestId('command-palette-backdrop').click({ position: { x: 10, y: 10 } })
  await expect(composer.editor).toBeFocused()
  await page.keyboard.type(' and backdrop')
  await expect(composer.editor).toContainText('Keep this draft after Escape and backdrop')

  await composer.editor.press('ControlOrMeta+A')
  await runPaletteCommand(page, 'Bold')
  await expect(composer.editor).toBeFocused()
  await expect(composer.editor.locator('strong')).toContainText('Keep this draft after Escape and backdrop')
})

test('persists command usage across relaunch', async ({ boot, page }) => {
  await runPaletteCommand(page, 'Go to Sent')
  await expect(page.getByTestId('view-title')).toHaveText('Sent')
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.attn.settings.getCommandUsage('seed@attn.test'))['view.sent']?.count ?? 0
      )
    )
    .toBe(1)

  ;({ page } = await boot.relaunch())
  await openPalette(page)
  await expect(page.getByTestId('command-palette')).toHaveAttribute('data-usage-loaded', 'true')
  await expect(page.getByTestId('command-palette-result').first()).toHaveAttribute(
    'data-command-id',
    'view.sent'
  )
})
