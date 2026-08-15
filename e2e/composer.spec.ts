import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
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
  const showCopies = page.getByTestId('composer-show-copies')
  await expect(showCopies).toBeVisible()
  await expect(showCopies).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('composer-discard')).toHaveAccessibleName('Discard draft')

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

  expect(await page.evaluate(() => window.attn.contacts.search('support'))).toEqual([])
  await toInput.fill('support')
  await expect(page.getByTestId('autocomplete-option')).toHaveCount(0)
  await toInput.press('Enter')
  await expect(toInput).toHaveAttribute('aria-invalid', 'true')
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
  await composer.expectPending(0)

  // `c` reactivates the single cleanly closed row rather than creating another.
  await composer.openNew()
  await composer.expectRecipients(['maya@example.com'])
  await expect(composer.subject).toHaveValue('A calmer inbox')
  await expect(composer.editor).toContainText('Focused work deserves focused mail. jke')
  await showCopies.click()
  await expect(composer.recipientField('cc')).toBeVisible()
  await expect(composer.recipientField('bcc')).toBeVisible()
})

test('adds links from the toolbar and the registered composer shortcut', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Visit Attn')
  await composer.editor.selectText()

  await page.getByTestId('composer-link').click()
  await page.getByTestId('composer-link-url').fill('attn.test')
  await page.getByTestId('composer-link-url').press('Enter')
  await expect(composer.editor.locator('a').first()).toHaveAttribute('href', 'https://attn.test')

  await page.keyboard.press('ControlOrMeta+Shift+k')
  await expect(page.getByTestId('composer-link-popover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-link-popover')).toHaveCount(0)
  await expect(composer.root).toBeVisible()
})

test('preserves comma names and pending recipients while keeping cleanly closed drafts closed', async ({
  boot,
  page
}) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  let input = composer.recipientField().locator('input')

  await input.fill('doe')
  await expect(page.getByTestId('autocomplete-option').first()).toContainText('Doe, John')
  await input.press('Tab')
  await composer.expectRecipients(['john.doe@example.com'])

  // Escape must commit valid text that has not yet become a chip.
  await input.fill('pending@example.com')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await composer.openNew()
  await composer.expectRecipients(['john.doe@example.com', 'pending@example.com'])

  // Invalid pending text keeps the composer open instead of being silently lost.
  input = composer.recipientField().locator('input')
  await input.fill('not-an-address')
  await page.keyboard.press('Escape')
  await expect(composer.root).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill('')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  // A deliberate save-and-close is discoverable with C, but is not crash recovery.
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toHaveCount(0)
  await composer.openNew()
  await composer.expectRecipients(['john.doe@example.com', 'pending@example.com'])
})

test('persists content supplied while creating an id-less draft', async ({ page }) => {
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  const draft = await page.evaluate(async () => {
    const { id } = await window.attn.draft.save({
      id: null,
      to: [{ name: 'Prefilled', email: 'prefilled@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Prefilled subject',
      bodyHtml: '<p>Prefilled body</p>',
      bodyText: 'Prefilled body',
      attachments: [],
      threadId: 'future-reply-thread',
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>']
    })
    return window.attn.draft.get(id)
  })

  expect(draft).toMatchObject({
    to: [{ name: 'Prefilled', email: 'prefilled@example.com' }],
    subject: 'Prefilled subject',
    bodyHtml: '<p>Prefilled body</p>',
    bodyText: 'Prefilled body',
    threadId: 'future-reply-thread',
    inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>']
  })
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

  const account = page.getByTestId('account-menu').getByRole('button').first()
  await account.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(conversation).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText(subject ?? '')
  expect(await selectedIndex(page)).toBe(before)
})

test('recovers a mirrored draft after relaunch without making initial content undoable', async ({
  app,
  boot,
  page
}) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('priya@example.com')
  await composer.subject.fill('Relaunch recovery')
  await composer.editor.click()
  await composer.typeBody('This draft survives a renderer and main-process restart.')

  // Let the trailing one-second checkpoint finish before simulating the crash.
  await composer.expectSaved()
  const draftId = await composer.root.getAttribute('data-draft-id')
  if (!draftId) throw new Error('composer did not expose its draft id')
  await app.evaluate(({ ipcMain }, { channel, id }) => ipcMain.emit(channel, {}, id), {
    channel: TEST_CHANNELS.markDraftMirrored,
    id: draftId
  })
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['priya@example.com'])
  await expect(composer.subject).toHaveValue('Relaunch recovery')
  await expect(composer.editor).toContainText('This draft survives a renderer and main-process restart.')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+z')
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

test('retries a failed autosave without clearing the dirty checkpoint', async ({ app, boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}), TEST_CHANNELS.failNextDraftSave)

  await composer.subject.fill('Retry this checkpoint')
  await expect(page.getByTestId('composer-save-status')).toHaveAttribute('data-save-status', 'error')
  await composer.expectSaved()

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(composer.subject).toHaveValue('Retry this checkpoint')
})

test('discard removes the local recovery surface', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Sensitive local draft')
  await composer.typeBody('Do not recover this text.')
  await composer.expectSaved()
  await page.getByTestId('composer-discard').click()
  await expect(composer.root).toHaveCount(0)

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toHaveCount(0)
})
