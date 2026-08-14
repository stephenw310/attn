import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

function selectedIndex(page: Page): Promise<number> {
  return page
    .getByTestId('thread-row')
    .evaluateAll((rows) => rows.findIndex((row) => row.hasAttribute('data-selected')))
}

test('opens the composer, validates chips, autocompletes locally, and saves on Escape', async ({
  page
}, testInfo) => {
  const composer = new ComposerPage(page)
  await composer.openNew()

  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('thread-list')).toBeHidden()
  await expect(page.getByTestId('footer-shortcuts')).toHaveCount(0)

  const toInput = composer.recipientField().locator('input')
  await expect.poll(() => toInput.evaluate((input) => document.activeElement === input)).toBe(true)

  await toInput.fill('may')
  await expect(page.getByTestId('autocomplete-option').first()).toContainText('Maya Lin')
  await toInput.press('Tab')
  await composer.expectRecipients(['maya@example.com'])

  await composer.addRecipient('not-an-address')
  await expect(toInput).toHaveAttribute('aria-invalid', 'true')
  await expect(composer.chips()).toHaveCount(1)
  await toInput.fill('')

  await composer.subject.fill('A calmer inbox')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+b')
  await composer.typeBody('Focused work deserves focused mail.')
  await page.keyboard.press('ControlOrMeta+b')

  // Text-entry keys belong to Lexical; they must never leak into list navigation or triage.
  const before = await selectedIndex(page)
  await composer.typeBody(' jke')
  expect(await selectedIndex(page)).toBe(before)
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer.png')
  await page.screenshot({ path })
  await testInfo.attach('composer', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  expect(await selectedIndex(page)).toBe(before)
  await expect(page.getByTestId('toast')).toContainText('Draft saved')
  await composer.expectPending(1)

  // `c` reopens the single live composing row rather than creating another.
  await composer.openNew()
  await composer.expectRecipients(['maya@example.com'])
  await expect(composer.subject).toHaveValue('A calmer inbox')
  await expect(composer.editor).toContainText('Focused work deserves focused mail. jke')
})

test('restores the same full-window reader after composing', async ({ page }) => {
  await page.getByTestId('thread-row').nth(2).click()
  const conversation = page.getByTestId('conversation-view')
  await expect(conversation).toBeVisible()
  const subject = await page.getByTestId('conversation-subject').textContent()
  const before = await selectedIndex(page)

  const composer = new ComposerPage(page)
  await composer.openNew()
  await expect(conversation).toBeHidden()
  await expect(page.getByTestId('footer-shortcuts')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(conversation).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText(subject ?? '')
  expect(await selectedIndex(page)).toBe(before)
})

test('recovers an idle-autosaved draft after a relaunch', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('priya@example.com')
  await composer.subject.fill('Relaunch recovery')
  await composer.editor.click()
  await composer.typeBody('This draft survives a renderer and main-process restart.')

  // Let the trailing one-second checkpoint finish before simulating the crash.
  await composer.expectPending(1)
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['priya@example.com'])
  await expect(composer.subject).toHaveValue('Relaunch recovery')
  await expect(composer.editor).toContainText('This draft survives a renderer and main-process restart.')
})

test('checkpoints continuously typed content without waiting for an idle gap', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.click()
  const continuous = 'Continuous typing still reaches durable storage before an idle debounce can ever fire.'

  // Eight seconds of uninterrupted input crosses the five-second hard checkpoint.
  // Relaunch immediately after the last character, before the one-second idle timer.
  await composer.editor.pressSequentially(continuous, { delay: 100 })
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText(continuous.slice(0, 40))
})
