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
  await expect(page.getByTestId('thread-list')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Acme annual roadmap')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeFocused()
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

test('fetches a server-only result, opens it, and keeps it cached across relaunch', async ({
  boot
}, testInfo) => {
  let page = await boot.app.firstWindow()
  await page.getByTestId('search-open').click()
  let input = page.getByTestId('search-input')
  await input.fill('serveronlyneedle')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '0')

  const searchAll = page.getByTestId('search-all-gmail')
  await expect(searchAll).toBeEnabled()
  await searchAll.click()
  await expect(page.getByTestId('thread-section-divider')).toHaveText('More from Gmail')
  const remote = page.locator('[data-testid="thread-row"][data-thread-id="t-search-server-only"]')
  await expect(remote).toBeVisible()
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await expect(input).toBeFocused()
  const serverSearchPath = join(artifactDirectory, 'server-search.png')
  await page.screenshot({ path: serverSearchPath })
  await testInfo.attach('server-search', { path: serverSearchPath, contentType: 'image/png' })
  await input.press('Enter')
  await expect(remote).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Remote archive result')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(
    page.locator('[data-testid="thread-row"][data-thread-id="t-search-server-only"]')
  ).toBeVisible()
  await expect(page.getByTestId('sidebar-mailbox').filter({ hasText: 'Inbox' })).toContainText('3')

  ;({ page } = await boot.relaunch())
  await page.getByTestId('search-open').click()
  input = page.getByTestId('search-input')
  await input.fill('serveronlyneedle')
  await expect(
    page.locator('[data-testid="thread-row"][data-thread-id="t-search-server-only"]')
  ).toBeVisible()
  await expect(page.getByTestId('thread-section-divider')).toHaveCount(0)
  expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
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

test('enters result browsing and returns to the query with its text intact', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  const list = page.getByTestId('thread-list')
  await input.fill('visualsort')
  await expect(list).toHaveAttribute('data-thread-count', '3')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0)
  await expect(page.getByTestId('footer-shortcut-search-browse')).toContainText('Enterbrowse results')
  await expect(page.getByTestId('footer-shortcut-navigate')).toHaveCount(0)

  const firstResult = page.locator('[data-testid="thread-row"][data-thread-id="t-search-origin"]')
  await expect(firstResult).not.toHaveAttribute('data-starred', 'true')
  await page.getByTestId('search-coverage').click()
  await page.keyboard.press('s')
  await expect(firstResult).not.toHaveAttribute('data-starred', 'true')
  await page.keyboard.press('j')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)

  await input.press('Enter')
  await expect(list).toBeFocused()
  await expect(list).toHaveCSS('outline-style', 'none')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(1)
  await expect(page.getByTestId('footer-shortcut-search-browse')).toHaveCount(0)
  await expect(page.getByTestId('footer-shortcut-navigate')).toContainText('J/K/↑/↓navigate')
  await page.keyboard.press('j')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveAttribute(
    'data-thread-id',
    't-search-return'
  )

  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('visualsort')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0)
  await expect(page.getByTestId('footer-shortcut-search-browse')).toBeVisible()

  await input.press('Enter')
  await page.keyboard.press('Backspace')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('visualsort')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0)

  await input.press('Enter')
  await page.keyboard.press('/')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('visualsort')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0)

  await input.press('Enter')
  await page.locator('[data-testid="thread-row"][data-selected="true"]').click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('visualsort')
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
  await expect(page.getByTestId('draft-row')).not.toHaveAttribute('data-selected', 'true')
  await input.press('Enter')
  await expect(page.getByTestId('draft-list')).toBeFocused()
  await expect(page.getByTestId('draft-list')).toHaveCSS('outline-style', 'none')
  await expect(page.getByTestId('draft-row')).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('Enter')

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
  await page.keyboard.press('Enter')
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
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('message-header')).toContainText('Normal Projection')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await input.fill('in:trash subject:"Projection switch"')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '1')
  await input.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('message-header')).toContainText('Trash Projection')
})

test('updates bulk flags and Inbox exits optimistically in search results', async ({ page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('in:inbox')
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(2)
  await input.press('Enter')

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

test('keeps an open search reader pinned while the underlying mailbox refreshes', async ({ app, page }) => {
  await page.getByTestId('search-open').click()
  const input = page.getByTestId('search-input')
  await input.fill('visualsort')
  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '3')
  await input.press('Enter')
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Acme annual roadmap')

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

  await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '2')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Acme annual roadmap')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveAttribute(
    'data-thread-id',
    't-search-acme'
  )
})

test('restores Outbox scroll after leaving search', async ({ app, page }) => {
  await app.evaluate(({ ipcMain }, request) => ipcMain.emit(request.channel, {}, request.delay), {
    channel: TEST_CHANNELS.setUndoSendDelay,
    delay: 600_000
  })
  await page.getByTestId('thread-list').waitFor()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.evaluate(() => window.attn.draft.takeRecovered())
  await page.evaluate(async () => {
    for (let index = 0; index < 30; index += 1) {
      const { id } = await window.attn.draft.save({
        id: null,
        kind: 'new',
        to: [{ name: '', email: `queued-${index}@example.test` }],
        cc: [],
        bcc: [],
        subject: `Queued message ${index}`,
        bodyHtml: '',
        bodyText: `Pending body ${index}`,
        attachments: [],
        threadId: null,
        sourceMessageId: null,
        inReplyTo: null,
        references: [],
        quoteHtml: '',
        quoteText: ''
      })
      await window.attn.outbox.send(id)
    }
  })

  await expect.poll(async () => (await page.evaluate(() => window.attn.outbox.listPending())).length).toBe(30)
  const outboxCount = page.getByTestId('outbox-count')
  await expect(outboxCount).toContainText('30 in Outbox')
  await expect(outboxCount).toBeEnabled()
  await outboxCount.click()
  const outbox = page.getByTestId('outbox-list')
  await expect(page.getByTestId('outbox-row')).toHaveCount(30)
  const savedScrollTop = await outbox.evaluate((list) => {
    list.scrollTop = list.scrollHeight
    return list.scrollTop
  })
  expect(savedScrollTop).toBeGreaterThan(0)

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('/')
  await expect(page.getByTestId('search-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(outbox).toBeVisible()
  await expect.poll(() => outbox.evaluate((list) => list.scrollTop)).toBe(savedScrollTop)
})
