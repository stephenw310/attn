import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './electron'
import { goTo } from './nav'
import { mailboxThreadIds } from './seams'

// F3 system mailbox navigation (T22): eight views over one seeded SQLite
// store, no provider and no network — switching is a local read.
test.use({ seed: 'fixtures/seed-inbox.json' })

async function createClosedDrafts(page: Page, count: number): Promise<void> {
  await page.evaluate(
    async (subjects) => {
      for (const subject of subjects) {
        const { id } = await window.attn.draft.save({
          id: null,
          kind: 'new',
          to: [],
          cc: [],
          bcc: [],
          subject,
          bodyHtml: '',
          bodyText: '',
          attachments: [],
          threadId: null,
          sourceMessageId: null,
          inReplyTo: null,
          references: [],
          quoteHtml: '',
          quoteText: '',
          followUpAt: null
        })
        await window.attn.draft.close(id)
      }
    },
    Array.from({ length: count }, (_, index) => `Restorable draft ${index + 1}`)
  )
}

test('every G chord reaches its mailbox and updates the semantic view name', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  const title = page.getByTestId('mailbox-title')
  await expect(rows).toHaveCount(8)
  await expect(title).toHaveText('Inbox')

  await goTo(page, 't')
  await expect(title).toHaveText('Sent')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Re: Q3 roadmap review')

  await goTo(page, 's')
  await expect(title).toHaveText('Starred')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Design notes')
  await expect(rows.last()).toContainText('Starred reference')

  await goTo(page, 'p')
  await expect(title).toHaveText('Spam')
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toContainText('Spam is empty')

  await goTo(page, 'r')
  await expect(title).toHaveText('Trash')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Q3 roadmap review')

  await goTo(page, 'h')
  await expect(title).toHaveText('Snoozed')
  await expect(page.getByTestId('thread-list')).toContainText('Nothing snoozed')

  await goTo(page, 'd')
  await expect(title).toHaveText('Drafts')
  await expect(page.getByTestId('view-title')).toHaveText('Drafts')

  await goTo(page, 'a')
  await expect(title).toHaveText('All Mail')
  // Every thread with a message outside Spam and Trash, including archived
  // Sent-only and Starred-only mail: 8 inbox threads + t-sent-history +
  // t-starred-archive.
  await expect(rows).toHaveCount(10)
  await expect(page.getByTestId('thread-done-indicator')).toHaveCount(2)
  await expect(
    rows
      .filter({ has: page.getByTestId('thread-done-indicator') })
      .evaluateAll((doneRows) => doneRows.map((row) => row.getAttribute('data-thread-id')))
  ).resolves.toEqual(['t-sent-history', 't-starred-archive'])
  await expect(
    page.locator(
      '[data-testid="thread-row"][data-thread-id="t-roadmap"] [data-testid="thread-done-indicator"]'
    )
  ).toHaveCount(0)
  const doneRow = page.locator('[data-testid="thread-row"][data-thread-id="t-starred-archive"]')
  const doneBox = await doneRow.getByTestId('thread-done-indicator').boundingBox()
  const timeBox = await doneRow.getByTestId('thread-time').boundingBox()
  expect((doneBox?.x ?? 0) > (timeBox?.x ?? 0)).toBe(true)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  await page.screenshot({ path: join(artifactDirectory, 'all-mail.png') })

  await goTo(page, 'i')
  await expect(title).toHaveText('Inbox')
  await expect(rows).toHaveCount(8)
})

test('the sidebar reaches every mailbox by pointer without moving', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const sidebar = page.getByTestId('mail-sidebar')
  const sidebarBox = await sidebar.boundingBox()
  await expect(page.getByTestId('sidebar-mailbox')).toHaveCount(8)
  const expectedCounts = new Map([
    ['Inbox', '8'],
    ['Starred', '2'],
    ['Snoozed', '0'],
    ['Drafts', '0'],
    ['Sent', '1'],
    ['All Mail', '10'],
    ['Spam', '0'],
    ['Trash', '1']
  ])
  for (const [title, count] of expectedCounts) {
    await expect(
      page.getByTestId('sidebar-mailbox').filter({ hasText: title }).getByTestId('sidebar-count')
    ).toHaveText(count)
  }
  await expect(page.getByTestId('sidebar-outbox').getByTestId('sidebar-count')).toHaveText('0')
  const inbox = page.getByTestId('sidebar-mailbox').filter({ hasText: 'Inbox' })
  // The chord stays discoverable in the tooltip and the cheat sheet rather
  // than printed beside every mailbox name.
  await expect(inbox).toHaveAttribute('title', 'Inbox (G I)')
  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Trash' }).click()
  await expect(page.getByTestId('mailbox-title')).toHaveText('Trash')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)

  await inbox.click()
  await expect(page.getByTestId('mailbox-title')).toHaveText('Inbox')
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(await sidebar.boundingBox()).toEqual(sidebarBox)
})

test('collapses the sidebar and keeps that choice across relaunch', async ({ boot, page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const titleBarPadding = await page.getByTestId('mail-header').evaluate((header) => {
    const style = getComputedStyle(header)
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) }
  })
  if (process.platform === 'darwin') expect(titleBarPadding.left).toBeGreaterThan(24)
  if (process.platform === 'win32') expect(titleBarPadding.right).toBeGreaterThan(24)
  const sidebar = page.getByTestId('mail-sidebar')
  await expect(page.getByTestId('sidebar-brand')).toContainText('attn')
  await expect(page.getByTestId('sidebar-brand').locator('div').first()).toHaveCSS('font-size', '40px')
  expect((await sidebar.boundingBox())?.width).toBe(216)
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-label', 'Collapse sidebar')
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute(
    'aria-keyshortcuts',
    process.platform === 'darwin' ? 'Meta+B' : 'Control+B'
  )
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute(
    'title',
    `Collapse sidebar (${process.platform === 'darwin' ? '⌘' : 'Ctrl'}B)`
  )

  await page.getByTestId('sidebar-toggle').click()
  await expect(sidebar).toHaveCount(0)
  await expect(page.getByTestId('sidebar-mailbox')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-label', 'Expand sidebar')
  await expect(page.getByTestId('mail-view-header')).toBeVisible()
  await expect(page.getByTestId('mailbox-title')).toHaveText('Inbox')
  const titleBox = await page.getByTestId('mailbox-title').boundingBox()
  const senderBox = await page.getByTestId('thread-sender').first().boundingBox()
  expect(titleBox?.x).toBeCloseTo(senderBox?.x ?? 0, 0)
  expect((await page.getByTestId('thread-list').boundingBox())?.x).toBe(0)
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  await goTo(page, 'a')
  await expect(page.getByTestId('mailbox-title')).toHaveText('All Mail')
  await goTo(page, 'i')
  await expect(page.getByTestId('mailbox-title')).toHaveText('Inbox')

  await page.keyboard.press('ControlOrMeta+B')
  await expect(sidebar).toBeVisible()
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-label', 'Collapse sidebar')
  await page.keyboard.press('ControlOrMeta+B')
  await expect(sidebar).toHaveCount(0)
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-label', 'Expand sidebar')

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'sidebar-collapsed.png')
  await page.screenshot({ path })
  await testInfo.attach('sidebar-collapsed', { path, contentType: 'image/png' })

  const relaunched = await boot.relaunch()
  const relaunchedSidebar = relaunched.page.getByTestId('mail-sidebar')
  await expect(relaunchedSidebar).toHaveCount(0)
  await expect(relaunched.page.getByTestId('sidebar-mailbox')).toHaveCount(0)
  await expect(relaunched.page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-label', 'Expand sidebar')

  await relaunched.page.getByTestId('sidebar-toggle').click()
  await expect(relaunchedSidebar).toBeVisible()
  expect((await relaunchedSidebar.boundingBox())?.width).toBe(216)
  await expect(relaunched.page.getByTestId('sidebar-mailbox')).toHaveCount(8)
  await expect(relaunched.page.getByTestId('sidebar-label')).toHaveCount(12)
})

test('opens user-label views from the sidebar and label chips', async ({ page }, testInfo) => {
  const labels = page.getByTestId('sidebar-label')
  await expect(labels).toHaveCount(12)

  const receipts = labels.filter({ hasText: 'receipts' })
  await receipts.click()
  await expect(receipts).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('mailbox-title')).toHaveText('receipts')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText('Your receipt')

  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Inbox' }).click()
  await page.getByTestId('thread-row').filter({ hasText: 'Design notes' }).getByTestId('label-chip').click()
  await expect(page.getByTestId('mailbox-title')).toHaveText('projects')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText('Design notes')

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'label-view.png')
  await page.screenshot({ path })
  await testInfo.attach('label-view', { path, contentType: 'image/png' })
})

test('keeps the trashed message as a reader marker that reveals locally and resets on close', async ({
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await goTo(page, 'a')
  await expect(page.getByTestId('thread-row')).toHaveCount(10)
  await expect(page.getByTestId('thread-row').first()).toHaveAttribute('data-thread-id', 't-roadmap')

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  const marker = page.getByTestId('trashed-message-marker')
  await expect(marker).toHaveCount(1)
  await expect(marker).toContainText('This message was moved to Trash.')
  await expect(page.getByTestId('conversation-content')).not.toContainText(
    'This deleted reply belongs only in Trash.'
  )

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  await page.screenshot({ path: join(artifactDirectory, 'trash-marker.png') })

  // Show message reveals in this reader only: no labels change, so the row
  // stays put and closing the reader forgets the reveal.
  await page.getByTestId('trashed-message-reveal').click()
  await expect(page.getByTestId('message-card')).toHaveCount(3)
  await expect(page.getByTestId('message-card').last()).toHaveAttribute('data-collapsed', 'false')
  await expect(page.getByTestId('conversation-content')).toContainText(
    'This deleted reply belongs only in Trash.'
  )

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('trashed-message-marker')).toHaveCount(1)

  // The Trash reader shows only its own messages, as ordinary cards.
  await page.keyboard.press('Escape')
  await goTo(page, 'r')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('message-card')).toHaveCount(1)
  await expect(page.getByTestId('trashed-message-marker')).toHaveCount(0)
  await expect(page.getByTestId('conversation-content')).toContainText(
    'This deleted reply belongs only in Trash.'
  )
})

test('restores per-view selection and scroll across a round trip', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // Shrink the window so ten windowed rows overflow and the list has to scroll.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 420)
  })
  await goTo(page, 'a')
  await expect(page.getByTestId('thread-row')).toHaveCount(10)

  for (let step = 0; step < 8; step++) await page.keyboard.press('j')
  const selected = page.locator('[data-testid="thread-row"][data-selected="true"]')
  await expect(selected).toHaveAttribute('data-thread-id', 't-research')
  const list = page.getByTestId('thread-list')
  const scrollTop = await list.evaluate((element) => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)

  await goTo(page, 'r')
  await expect(page.getByTestId('mailbox-title')).toHaveText('Trash')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)

  await goTo(page, 'a')
  await expect(page.getByTestId('thread-row')).toHaveCount(10)
  await expect(selected).toHaveAttribute('data-thread-id', 't-research')
  await expect.poll(async () => list.evaluate((element) => element.scrollTop)).toBe(scrollTop)
})

test('restores Drafts selection and scroll across a mailbox round trip', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await createClosedDrafts(page, 18)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 420)
  })

  await goTo(page, 'd')
  const rows = page.getByTestId('draft-row')
  await expect(rows).toHaveCount(18)
  for (let step = 0; step < 12; step++) await page.keyboard.press('j')

  const selected = page.locator('[data-testid="draft-row"][data-selected="true"]')
  const selectedId = await selected.getAttribute('data-draft-id')
  expect(selectedId).not.toBeNull()
  const list = page.getByTestId('draft-list')
  const scrollTop = await list.evaluate((element) => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)

  await goTo(page, 'i')
  await expect(page.getByTestId('mailbox-title')).toHaveText('Inbox')
  await goTo(page, 'd')
  await expect(rows).toHaveCount(18)
  await expect(selected).toHaveAttribute('data-draft-id', selectedId ?? '')
  await expect.poll(async () => list.evaluate((element) => element.scrollTop)).toBe(scrollTop)
})

test('a triage verb removes a row only from views it no longer matches', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await goTo(page, 'a')
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(10)
  await expect(rows.first()).toHaveAttribute('data-thread-id', 't-roadmap')
  await expect(rows.first().getByTestId('thread-done-indicator')).toHaveCount(0)

  // Archiving in All Mail removes nothing: membership ignores INBOX.
  await page.keyboard.press('e')
  await expect(page.getByTestId('toast')).toContainText('Marked done')
  await expect(rows).toHaveCount(10)
  await expect(rows.first()).toHaveAttribute('data-unread', 'true')
  await expect(rows.first().getByTestId('thread-done-indicator')).toBeVisible()

  // Marking not done restores Inbox membership without leaving All Mail.
  await page.keyboard.press('Shift+E')
  await expect(page.getByTestId('toast')).toContainText('Marked not done')
  await expect(rows).toHaveCount(10)
  await expect(rows.first().getByTestId('thread-done-indicator')).toHaveCount(0)

  await page.keyboard.press('e')
  await expect(rows.first().getByTestId('thread-done-indicator')).toBeVisible()

  // Trashing moves every message to Trash, so the thread leaves All Mail.
  await page.keyboard.press('#')
  await expect(page.getByTestId('toast')).toContainText('Trashed')
  await expect(rows).toHaveCount(9)

  await goTo(page, 'r')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-thread-id', 't-roadmap')

  // Undo restores the thread out of Trash, removing its row here in turn.
  await page.keyboard.press('z')
  await expect(page.getByTestId('toast')).toContainText('Undid trashed')
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toContainText('Trash is empty')

  await goTo(page, 'a')
  await expect(rows).toHaveCount(10)
})

// Moved here from a spec of its own (T5): same seed, same thread, same opening
// assertions as the trashed-message reader test above.
test('keeps a partially trashed thread in All Mail and Trash while the normal reader keeps its body hidden', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(await mailboxThreadIds(app, 'all-mail')).toContain('t-roadmap')
  expect(await mailboxThreadIds(app, 'trash')).toContain('t-roadmap')
  expect(await mailboxThreadIds(app, 'spam')).not.toContain('t-roadmap')

  const roadmapRow = page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' })
  await expect(roadmapRow.getByTestId('thread-snippet')).toContainText('I added the launch milestones.')
  await expect(roadmapRow).not.toContainText('This deleted reply belongs only in Trash.')
  await roadmapRow.click()
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('conversation-content')).not.toContainText(
    'This deleted reply belongs only in Trash.'
  )
  await expect(page.getByTestId('conversation-content')).not.toContainText(
    'This unsent Gmail draft must never render as a message.'
  )
})
