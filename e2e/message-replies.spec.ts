import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-message-replies.json' })

async function expectComposerAfter(page: Page, messageId: string): Promise<void> {
  const composerItem = page.getByTestId('conversation-latest-item')
  await expect(composerItem).toHaveAttribute('data-composer-source-message-id', messageId)
  await expect
    .poll(() =>
      composerItem.evaluate((element) => element.previousElementSibling?.getAttribute('data-message-id'))
    )
    .toBe(messageId)
  await expect(page.getByTestId('composer')).toHaveCount(1)
}

test('the visible message cursor targets reply, reply all, and forward shortcuts', async ({
  page
}, testInfo) => {
  await page.getByTestId('thread-row').first().click()
  const messages = page.getByTestId('conversation-message')
  await expect(messages.last().getByTestId('message-cursor')).toBeVisible()
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await expect(messages.first().getByTestId('message-cursor')).toBeVisible()
  await expect(page.getByTestId('message-cursor')).toHaveCount(1)
  await expect(messages.first().getByTestId('message-card')).toHaveAttribute('data-collapsed', 'true')
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const cursorPath = join(dir, 'message-cursor.png')
  await page.screenshot({ path: cursorPath })
  await testInfo.attach('message cursor', { path: cursorPath, contentType: 'image/png' })

  for (const key of ['r', 'a', 'Enter', 'f']) {
    await page.keyboard.press(key)
    const composer = new ComposerPage(page)
    await composer.expectRecipients(key === 'f' ? [] : ['jordan+support@example.com'])
    await composer.expectRecipients(key === 'a' || key === 'Enter' ? ['support@example.com'] : [], 'cc')
    await expectComposerAfter(page, 'm-customer')
    await expect(messages.first().getByTestId('message-card')).toHaveAttribute('data-collapsed', 'false')
    await expect(composer.editor).toBeInViewport()
    await expect(messages.first()).toBeInViewport()
    await expect
      .poll(() =>
        page
          .getByTestId('conversation-latest-item')
          .evaluate((element) => element.nextElementSibling?.getAttribute('data-message-id'))
      )
      .toBe('m-forward')
    if (key === 'r') {
      const path = join(dir, 'message-inline-reply.png')
      await page.screenshot({ path })
      await testInfo.attach('reply beneath selected message', { path, contentType: 'image/png' })
      await page.emulateMedia({ colorScheme: 'light' })
      await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'light')
      const lightPath = join(dir, 'message-inline-reply-light.png')
      await page.screenshot({ path: lightPath })
      await testInfo.attach('reply beneath selected message in light theme', {
        path: lightPath,
        contentType: 'image/png'
      })
      await page.emulateMedia({ colorScheme: 'dark' })
    }
    if (key === 'f') await expect(composer.attachmentChips).toContainText('account.txt')
    await page.getByTestId('composer-close').click()
    await expect(composer.root).toHaveCount(0)
    await expect(messages.first().getByTestId('message-cursor')).toBeVisible()
  }

  await page.keyboard.press('n')
  await expect(messages.nth(1).getByTestId('message-cursor')).toBeVisible()
  await page.keyboard.press('r')
  const composer = new ComposerPage(page)
  await composer.expectRecipients(['christy@example.com'])
  await expectComposerAfter(page, 'm-forward')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)

  await messages.last().getByTestId('message-header').click()
  await expect(messages.last().getByTestId('message-cursor')).toBeVisible()
  await page.keyboard.press('f')
  await expectComposerAfter(page, 'm-colleague')
  await expect(composer.attachmentChips).toContainText('internal.txt')
})

test('undo send returns the draft beneath the earlier source message', async ({ app, page }) => {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 20), TEST_CHANNELS.setUndoSendDelay)
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('message-card')).toHaveCount(3)
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await page.keyboard.press('r')
  const composer = new ComposerPage(page)
  await composer.expectRecipients(['jordan+support@example.com'])
  await composer.typeBody('A reply to the original customer')
  await composer.triggerSend()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('message-card').last()).toHaveAttribute('data-pending', 'true')
  await expect(page.getByTestId('conversation-scroll')).toBeFocused()
  await page.keyboard.press('z')
  await expectComposerAfter(page, 'm-customer')
  await expect(composer.editor).toContainText('A reply to the original customer')
  await composer.expectRecipients(['jordan+support@example.com'])
  await expect(page.getByTestId('message-card')).toHaveCount(3)
  await expect(page.getByTestId('conversation-message').first().getByTestId('message-cursor')).toBeVisible()
})

test('replies to an earlier message without reusing a colleague draft or quoting their exchange', async ({
  page
}, testInfo) => {
  await page.getByTestId('thread-row').first().click()
  let composer = new ComposerPage(page)
  await composer.openReply()
  await composer.expectRecipients(['christy@example.com'])
  await composer.typeBody('Private answer to Christy')
  await composer.expectSaved()
  const colleagueDraftId = await composer.root.getAttribute('data-draft-id')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)

  const customer = page.getByTestId('message-card').first()
  await customer.getByTestId('older-message-toggle').click()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'message-reply-actions.png')
  await page.screenshot({ path })
  await testInfo.attach('message reply actions', { path, contentType: 'image/png' })
  await customer.getByTestId('message-reply').click()
  composer = new ComposerPage(page)
  await composer.expectRecipients(['jordan+support@example.com'])
  await expectComposerAfter(page, 'm-customer')
  const customerDraftId = await composer.root.getAttribute('data-draft-id')
  expect(customerDraftId).not.toBe(colleagueDraftId)
  await composer.typeBody('Public answer to Jordan')
  await composer.expectSaved()
  await expect(customer.getByTestId('message-actions')).toHaveCount(0)
  await expect(page.getByTestId('message-card').last().getByTestId('message-forward')).toBeDisabled()
  const saved = await page.evaluate(async (id) => window.attn.draft.get(id ?? ''), customerDraftId)
  expect(saved?.sourceMessageId).toBe('m-customer')
  expect(saved?.inReplyTo).toBe('<customer@example.com>')
  expect(saved?.references).toEqual(['<customer@example.com>'])
  expect(saved?.quoteText).toContain('Can you help with my account?')
  expect(saved?.quoteText).not.toContain('Internal account notes')
  expect(saved?.attachments).toEqual([])
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)

  await page.getByTestId('conversation-back').click()
  await page.getByTestId('thread-row').first().click()
  await expect(composer.root).toHaveAttribute('data-draft-id', customerDraftId ?? '')
  await expectComposerAfter(page, 'm-customer')
  await expect(page.getByTestId('conversation-message').first().getByTestId('message-cursor')).toBeVisible()
  await expect(composer.editor).toContainText('Public answer to Jordan')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)

  await page.keyboard.press('a')
  await expect(composer.root).toHaveAttribute('data-draft-id', customerDraftId ?? '')
  await composer.expectRecipients(['jordan+support@example.com'])
  await composer.expectRecipients(['support@example.com'], 'cc')
  await expect(composer.editor).toContainText('Public answer to Jordan')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)

  await customer.getByTestId('message-forward').click()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await composer.expectRecipients([])
  await expect(composer.attachmentChips).toHaveCount(1)
  await expect(composer.attachmentChips).toContainText('account.txt')
  const forward = await page.evaluate(
    async (id) => window.attn.draft.get(id ?? ''),
    await composer.root.getAttribute('data-draft-id')
  )
  expect(forward?.sourceMessageId).toBe('m-customer')
  expect(forward?.inReplyTo).toBeNull()
  expect(forward?.references).toEqual([])
  expect(forward?.quoteText).not.toContain('Internal account notes')
  const colleague = await page.evaluate(
    async (id) => (await window.attn.draft.list()).find((draft) => draft.id === id),
    colleagueDraftId
  )
  expect(colleague?.bodyText).toContain('Private answer to Christy')
  expect(colleague?.to.map((address) => address.email)).toEqual(['christy@example.com'])
})

test('reply shortcuts keep working in a conversation opened from Drafts', async ({ page }) => {
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('message-card')).toHaveCount(3)
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await page.keyboard.press('r')
  const composer = new ComposerPage(page)
  await composer.expectRecipients(['jordan+support@example.com'])
  await composer.typeBody('Keep this customer reply')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await page.getByTestId('draft-row').click()
  await expectComposerAfter(page, 'm-customer')
  await expect(composer.editor).toContainText('Keep this customer reply')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('n')
  await expect(page.getByTestId('conversation-message').nth(1).getByTestId('message-cursor')).toBeVisible()
  await page.keyboard.press('r')
  await composer.expectRecipients(['christy@example.com'])
  await expectComposerAfter(page, 'm-forward')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('draft-list')).toBeVisible()
  await expect(page.getByTestId('draft-row')).toHaveCount(1)
})

test('targets the active message from the palette and rejects unrelated source ids', async ({ page }) => {
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('message-card')).toHaveCount(3)
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await expect(page.getByTestId('conversation-message').first()).toHaveAttribute(
    'data-active-message',
    'true'
  )
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-input').fill('Reply to this message')
  await page.getByTestId('command-palette-input').press('Enter')
  const composer = new ComposerPage(page)
  await composer.expectRecipients(['jordan+support@example.com'])
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      window.attn.draft.createReply('t-side-conversation', 'reply', 'normal', 'unrelated-message')
    )
  ).toBeNull()
  expect(await page.evaluate(() => window.attn.draft.list())).toEqual([])
})

test.describe('revealed Trash messages', () => {
  test.use({ seed: 'fixtures/seed-inbox.json' })

  test('can reply to a revealed message without changing its Trash label', async ({ page }) => {
    await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
    await page.getByTestId('trashed-message-reveal').click()
    const trashed = page
      .getByTestId('message-card')
      .filter({ hasText: 'This deleted reply belongs only in Trash.' })
    await trashed.getByTestId('message-reply').click()
    const composer = new ComposerPage(page)
    await composer.expectRecipients(['maya@example.com'])
    const draft = await page.evaluate(
      async (id) => window.attn.draft.get(id ?? ''),
      await composer.root.getAttribute('data-draft-id')
    )
    expect(draft?.sourceMessageId).toBe('m-roadmap-trash')
    expect(draft?.quoteText).toContain('This deleted reply belongs only in Trash.')
    await page.getByTestId('composer-close').click()
    await page.getByTestId('conversation-back').click()
    await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
    await expect(page.getByTestId('trashed-message-marker')).toHaveCount(1)
  })
})
