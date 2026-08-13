import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { mockThreads } from '../src/renderer/src/mockData'
import { expect, test } from './electron'

const initialUnread = mockThreads.filter((thread) => thread.unread).length

function selectedIndex(page: Page): Promise<number> {
  return page
    .getByTestId('thread-row')
    .evaluateAll((rows) => rows.findIndex((row) => row.hasAttribute('data-selected')))
}

test('boots the built app with an isolated store and working IPC bridge', async ({
  app,
  page,
  userData,
  mainLog
}) => {
  await expect(page).toHaveTitle('Attn')
  await expect(page.getByTestId('thread-row').first()).toBeVisible()
  await expect(page.getByTestId('thread-date-group')).toHaveText([
    'Today',
    'Yesterday',
    'Last 7 days',
    'Earlier this month'
  ])

  const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  expect(resolvedUserData).toBe(userData)
  expect(existsSync(join(userData, 'attn.db'))).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(
    process.env.ATTN_E2E_VISIBLE === '1'
  )

  // The teed main.log covers boot-time lines (Playwright consumes early
  // stdout), so the store's open/migrate line is assertable — inside the
  // isolated dir, at a migrated schema version.
  await expect.poll(mainLog).toMatch(/\[log\] \[db\] open at .*attn-e2e-.*attn\.db \(schema v\d+\)/)

  expect(await page.evaluate(() => typeof window.attn?.mail.listThreads)).toBe('function')
  expect(await page.evaluate(() => window.attn.auth.getStatus())).toEqual({
    configured: false,
    signedIn: false
  })
  expect(await page.evaluate(() => window.attn.mail.listThreads())).toEqual([])
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(0)
  expect(await page.evaluate(() => window.attn.mail.getConversation('no-such-thread'))).toBeNull()
  expect(await page.evaluate(() => window.attn.sync.getState())).toEqual({ phase: 'idle' })
  expect(mainLog()).not.toContain('[sync] history poller started')
})

test('renders the signed-out Dispatch inbox', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(mockThreads.length)
  await expect(rows.first()).toContainText(mockThreads[0].from)
  await expect(rows.first()).toContainText(mockThreads[0].subject)

  await expect(page.getByTestId('account-menu')).toHaveText(/OAuth not configured/)
  await expect(page.getByTestId('status-note')).toContainText('Not connected')
  await expect(page.getByTestId('status-note')).toContainText('Demo inbox')
  await expect(page.getByTestId('status-note')).toHaveAttribute('data-status', 'disconnected')
  await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread} to zero`)
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect(page.getByTestId('footer-shortcut-navigate')).toContainText('J/K/↑/↓navigate')
  await expect(page.getByTestId('footer-shortcut-open')).toContainText('Enteropen')
  for (const [id, text] of [
    ['done', 'Edone'],
    ['trash', '#trash'],
    ['star', 'Sstar'],
    ['unread', 'Uunread'],
    ['spam', '!spam'],
    ['undo', 'Zundo']
  ]) {
    await expect(page.getByTestId(`footer-shortcut-${id}`)).toContainText(text)
  }
})

test('keeps triage verbs inert in signed-out mock mode', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(mockThreads.length)
  await rows.first().click()
  await page.keyboard.press('e')
  await page.keyboard.press('#')
  await page.keyboard.press('s')
  await expect(rows).toHaveCount(mockThreads.length)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)
})

test('J/K and arrow keys move list selection without opening a conversation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(mockThreads.length)
  await expect.poll(() => selectedIndex(page)).toBe(0)

  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(2)

  await page.keyboard.press('ArrowDown')
  await expect.poll(() => selectedIndex(page)).toBe(3)

  await page.keyboard.press('k')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => selectedIndex(page)).toBe(1)

  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await expect.poll(() => selectedIndex(page)).toBe(0)
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})

test('Enter opens the full-window reader; J/K navigates; Back and Esc restore the list', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(mockThreads.length)
  await expect(rows.first()).toHaveAttribute('data-unread', 'true')
  await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread} to zero`)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('thread-list')).toBeHidden()
  await expect(page.getByTestId('conversation-back')).toHaveText('← Inbox')
  await expect(page.getByTestId('conversation-subject')).toHaveText(mockThreads[0].subject)
  await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${mockThreads.length}`)
  await expect(page.getByTestId('footer-shortcut-navigate')).toContainText('J/Knext conversation')
  await expect(page.getByTestId('footer-shortcut-scroll')).toContainText('↑/↓/Spacescroll')
  await expect(page.getByTestId('footer-shortcut-back')).toContainText('Escback to list')
  await expect(page.getByTestId('footer-shortcut-done')).toContainText('Edone')
  // Pin the whole reader hint set rather than the absence of named hints: this
  // fails on a stray hint too, and cannot go vacuous when an id is renamed.
  await expect
    .poll(() =>
      page
        .getByTestId('footer-shortcuts')
        .evaluate((element) =>
          Array.from(element.querySelectorAll('[data-testid^="footer-shortcut-"]')).map((hint) =>
            hint.getAttribute('data-testid')?.replace('footer-shortcut-', '')
          )
        )
    )
    .toEqual([
      'navigate',
      'scroll',
      'back',
      'select',
      'done',
      'snooze',
      'label',
      'trash',
      'star',
      'unread',
      'spam',
      'undo'
    ])
  await expect(page.getByTestId('message-card')).toHaveCount(1)
  await expect(page.getByTestId('message-card').first()).toContainText('Maya Lin')
  await expect(rows.first()).not.toHaveAttribute('data-unread', 'true')
  await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread - 1} to zero`)

  await page
    .getByTestId('conversation-content')
    .evaluate((element) => element.style.setProperty('min-height', '4000px'))
  const scroll = page.getByTestId('conversation-scroll')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(120)
  const afterArrow = await scroll.evaluate((element) => element.scrollTop)
  await page.keyboard.press('Space')
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterArrow)
  const afterSpace = await scroll.evaluate((element) => element.scrollTop)
  await page.keyboard.press('PageDown')
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterSpace)
  await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${mockThreads.length}`)
  await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
  await page
    .getByTestId('conversation-content')
    .evaluate((element) => element.style.removeProperty('min-height'))

  // Precondition for the count math below: advancing must land on an unread
  // thread, or the -2 expectation silently depends on fixture data.
  await expect(rows.nth(1)).toHaveAttribute('data-unread', 'true')
  await page.keyboard.press('j')
  await expect(page.getByTestId('conversation-subject')).toHaveText(mockThreads[1].subject)
  await expect(page.getByTestId('conversation-position')).toHaveText(`2 of ${mockThreads.length}`)
  await expect.poll(() => selectedIndex(page)).toBe(1)
  await expect(rows.nth(1)).not.toHaveAttribute('data-unread', 'true')
  await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread - 2} to zero`)

  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('conversation-position')).toHaveText(`2 of ${mockThreads.length}`)
  await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${mockThreads.length}`)
  await page.getByTestId('conversation-back').click()
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect.poll(() => selectedIndex(page)).toBe(0)

  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect.poll(() => selectedIndex(page)).toBe(0)
})

test('restores list scroll on reader exit, and follows a cursor moved by J/K', async ({ app, page }) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 480))
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(700)

  for (let index = 1; index < mockThreads.length; index++) await page.keyboard.press('j')
  const list = page.getByTestId('thread-list')
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const before = await list.evaluate((element) => element.scrollTop)
  const selectedBefore = await selectedIndex(page)
  expect(selectedBefore).toBeGreaterThan(0)

  // Reading without navigating must land back on the exact same offset.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeVisible()
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(before)
  await expect.poll(() => selectedIndex(page)).toBe(selectedBefore)

  // Navigating inside the reader moves the cursor while the list is
  // display:none and cannot scroll — returning has to bring it back into view.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  for (let index = selectedBefore; index > 0; index--) await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${mockThreads.length}`)
  await page.keyboard.press('Escape')

  await expect(list).toBeVisible()
  await expect.poll(() => selectedIndex(page)).toBe(0)
  await expect
    .poll(async () => {
      const viewport = await list.boundingBox()
      const row = await page.getByTestId('thread-row').first().boundingBox()
      if (!viewport || !row) return false
      return row.y >= viewport.y - 1 && row.y + row.height <= viewport.y + viewport.height + 1
    })
    .toBe(true)
})

test('captures the Dispatch inbox for visual review', async ({ page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(mockThreads.length)
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'inbox.png')
  await page.screenshot({ path })
  await testInfo.attach('inbox', { path, contentType: 'image/png' })
})
