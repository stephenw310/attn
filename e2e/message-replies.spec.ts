import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-message-replies.json' })

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
  const customerDraftId = await composer.root.getAttribute('data-draft-id')
  expect(customerDraftId).not.toBe(colleagueDraftId)
  await composer.typeBody('Public answer to Jordan')
  await composer.expectSaved()
  await expect(customer.getByTestId('message-forward')).toBeDisabled()
  const saved = await page.evaluate(async (id) => window.attn.draft.get(id ?? ''), customerDraftId)
  expect(saved?.sourceMessageId).toBe('m-customer')
  expect(saved?.inReplyTo).toBe('<customer@example.com>')
  expect(saved?.references).toEqual(['<customer@example.com>'])
  expect(saved?.quoteText).toContain('Can you help with my account?')
  expect(saved?.quoteText).not.toContain('Internal account notes')
  expect(saved?.attachments).toEqual([])
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
