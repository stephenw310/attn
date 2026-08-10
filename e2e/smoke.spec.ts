import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { mockThreads } from '../src/renderer/src/mockData'
import { expect, test } from './electron'

// M0 smoke suite: proves the app boots, the local store opens, the preload
// bridge + IPC work, and the J/K/Enter/Esc triage-navigation loop behaves —
// all against deterministic mock data (signed-out state). This is the suite
// `npm run verify` gates on; extend it as milestones land (see CLAUDE.md).

const initialUnread = mockThreads.filter((t) => t.unread).length

function selectedIndex(page: Page): Promise<number> {
  return page
    .locator('[data-testid="thread-row"]')
    .evaluateAll((rows) => rows.findIndex((r) => r.hasAttribute('data-selected')))
}

test('boots clean: window, local store, typed IPC bridge', async ({ app, page, userData }) => {
  await expect(page).toHaveTitle('Attn')
  await expect(page.locator('[data-testid="thread-row"]').first()).toBeVisible()

  // The ATTN_TEST_USER_DATA seam is active (hermetic run), and the main
  // process created the SQLite store inside it.
  const resolvedUserData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  expect(resolvedUserData).toBe(userData)
  expect(existsSync(join(userData, 'attn.db'))).toBe(true)

  // contextBridge survived sandbox + contextIsolation, and full IPC
  // roundtrips work against the empty store.
  const bridge = await page.evaluate(() => typeof window.attn?.mail.listThreads)
  expect(bridge).toBe('function')
  expect(await page.evaluate(() => window.attn.auth.getStatus())).toEqual({
    configured: false,
    signedIn: false
  })
  expect(await page.evaluate(() => window.attn.mail.listThreads())).toEqual([])
  expect(await page.evaluate(() => window.attn.mail.getConversation('no-such-thread'))).toBeNull()
  expect(await page.evaluate(() => window.attn.sync.getState())).toEqual({ phase: 'idle' })
})

test('renders the mock inbox in signed-out state', async ({ page }) => {
  const rows = page.locator('[data-testid="thread-row"]')
  await expect(rows).toHaveCount(mockThreads.length)
  await expect(rows.first()).toContainText(mockThreads[0].from)
  await expect(rows.first()).toContainText(mockThreads[0].subject)

  await expect(page.getByTestId('account-chip')).toHaveText(/OAuth not configured/)
  await expect(page.getByTestId('status-note')).toHaveText('M0 walking skeleton · mock data')
  await expect(page.getByTestId('unread-count')).toHaveText(String(initialUnread))
})

test('J/K and arrow keys move the selection; the reading pane follows', async ({ page }) => {
  await expect(page.locator('[data-testid="thread-row"]')).toHaveCount(mockThreads.length)
  await expect.poll(() => selectedIndex(page)).toBe(0)
  await expect(page.getByTestId('conversation-subject')).toHaveText(mockThreads[0].subject)

  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(2)
  await expect(page.getByTestId('conversation-subject')).toHaveText(mockThreads[2].subject)

  await page.keyboard.press('ArrowDown')
  await expect.poll(() => selectedIndex(page)).toBe(3)

  await page.keyboard.press('k')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => selectedIndex(page)).toBe(1)

  // Top boundary: K at the first row stays put.
  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await expect.poll(() => selectedIndex(page)).toBe(0)
})

test('Enter opens a conversation and marks it read; Esc returns to the list', async ({ page }) => {
  const rows = page.locator('[data-testid="thread-row"]')
  const pane = page.locator('section[aria-label="Conversation"]')
  await expect(rows).toHaveCount(mockThreads.length)
  await expect(pane).toHaveAttribute('data-focus', 'list')
  await expect(rows.first()).toHaveAttribute('data-unread', 'true')

  await page.keyboard.press('Enter')
  await expect(pane).toHaveAttribute('data-focus', 'conversation')
  await expect(rows.first()).not.toHaveAttribute('data-unread', 'true')
  await expect(page.getByTestId('unread-count')).toHaveText(String(initialUnread - 1))
  await expect(page.getByTestId('message-card')).toHaveCount(1)
  await expect(page.getByTestId('message-card').first()).toContainText('Maya Lin')

  await page.keyboard.press('Escape')
  await expect(pane).toHaveAttribute('data-focus', 'list')
})

test('captures the inbox for visual review', async ({ page }, testInfo) => {
  await expect(page.locator('[data-testid="thread-row"]')).toHaveCount(mockThreads.length)
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'inbox.png')
  await page.screenshot({ path })
  await testInfo.attach('inbox', { path, contentType: 'image/png' })
})
