import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-search.json' })

const artifactDirectory = join(__dirname, '.artifacts')

test('searches locally as typed and restores the mailbox after reading a result', async ({ page }) => {
  const original = page.locator('[data-testid="thread-row"][data-selected="true"]')
  const originalId = await original.getAttribute('data-thread-id')

  await page.keyboard.press('/')
  const input = page.getByTestId('search-input')
  await expect(input).toBeFocused()

  await input.fill('from:ac')
  await expect(page.locator('[data-testid="thread-row"][data-thread-id="t-search-acme"]')).toBeVisible()

  const combinedQuery = 'from:acme.com has:attachment after:2026-01-01'
  await input.fill(combinedQuery)
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await expect(page.locator('[data-testid="thread-row"][data-thread-id="t-search-acme"]')).toBeVisible()
  await expect(page.getByTestId('search-coverage')).toHaveAttribute('data-search-query', combinedQuery)

  await input.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Acme annual roadmap')

  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(combinedQuery)
  await page.keyboard.press('Escape')

  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveAttribute(
    'data-thread-id',
    originalId ?? ''
  )
})

test('sorts text results newest first and keeps their date headers separated', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('visualsort')
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(3)
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-thread-id')))).toEqual(
    ['t-search-origin', 't-search-return', 't-search-acme']
  )
  const timestamps = await rows.evaluateAll((items) =>
    items.map((item) => Number(item.getAttribute('data-last-msg-at')))
  )
  expect(timestamps).toEqual([...timestamps].sort((left, right) => right - left))

  const headerTops = await page
    .getByTestId('thread-date-group')
    .evaluateAll((headers) => headers.map((header) => (header as HTMLElement).style.top))
  expect(new Set(headerTops).size).toBe(headerTops.length)
  await page.screenshot({ path: join(artifactDirectory, 'search.png') })
})

test('opens an outbox-backed Drafts result in the composer', async ({ page }) => {
  const draftId = await page.evaluate(async () => {
    const { id } = await window.attn.draft.save({
      id: null,
      kind: 'new',
      to: [{ name: 'Morgan', email: 'morgan@example.test' }],
      cc: [],
      bcc: [],
      subject: 'Quarterly draft review',
      bodyHtml: '',
      bodyText: 'Unsent forecast notes',
      attachments: [],
      threadId: null,
      sourceMessageId: null,
      inReplyTo: null,
      references: [],
      quoteHtml: '',
      quoteText: ''
    })
    await window.attn.draft.close(id)
    return id
  })

  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('in:drafts to:morgan subject:quarterly')
  await expect(page.getByTestId('draft-row')).toHaveAttribute('data-draft-id', draftId)
  await input.press('Enter')

  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(composer.subject).toHaveValue('Quarterly draft review')
})

test('plans a reply from the mailbox projection selected by the search query', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('in:trash subject:"Trashed reply source"')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()

  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.expectRecipients(['trash.reply@example.com'])
})

test('refetches the same thread when its search mailbox projection changes', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('subject:"Projection switch"')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await input.press('Enter')
  await expect(page.getByTestId('message-header')).toContainText('Normal Projection')

  await page.keyboard.press('Escape')
  await input.fill('in:trash subject:"Projection switch"')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await input.press('Enter')
  await expect(page.getByTestId('message-header')).toContainText('Trash Projection')
})

test('updates bulk flags and Inbox exits optimistically in search results', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('in:inbox')
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(2)
  await input.blur()

  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await expect(page.locator('[data-testid="thread-row"][data-checked="true"]')).toHaveCount(2)
  await page.keyboard.press('s')
  await expect(page.locator('[data-testid="thread-row"][data-starred="true"]')).toHaveCount(2)

  await page.keyboard.press('e')
  await expect(page.locator('[data-testid="thread-row"][data-exiting="true"]')).toHaveCount(1)
  await expect(rows).toHaveCount(1)
})

test('restores the selected thread by id when the mailbox reorders during search', async ({ app, page }) => {
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '2')
  await page.keyboard.press('j')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveAttribute(
    'data-thread-id',
    't-search-return'
  )
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('from:acme.com')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')

  const result = await app.evaluate(
    ({ ipcMain }, request) =>
      new Promise<{ error?: string }>((resolve) => ipcMain.emit(request.channel, {}, request.input, resolve)),
    {
      channel: TEST_CHANNELS.runExistenceSweep,
      input: {
        allMailThreadIds: ['t-search-acme', 't-search-return'],
        spamThreadIds: [],
        trashThreadIds: ['t-search-trash']
      }
    }
  )
  if (result.error) throw new Error(result.error)

  await input.press('Escape')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveAttribute(
    'data-thread-id',
    't-search-return'
  )
})
