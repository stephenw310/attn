import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { setSyncState } from './seams'

test.describe('complete Inbox metadata', () => {
  test.use({ seed: 'fixtures/seed-splits.json' })

  test('shows a local reward with the remaining split counts', async ({ page }, testInfo) => {
    const importantRow = page.getByTestId('thread-row')
    await expect(importantRow).toHaveCount(1)
    await expect(importantRow).toContainText('Board memo needs approval')

    await page.keyboard.press('e')

    const zero = page.getByTestId('inbox-zero')
    await expect(zero).toBeVisible()
    await expect(page.getByTestId('inbox-zero-message')).toContainText('Inbox zero')
    await expect(page.getByTestId('inbox-zero-message').locator('time')).toHaveText(/\d{1,2}:\d{2}/)
    await expect(page.getByTestId('inbox-zero-split')).toHaveText([
      'Calendar: 2 total',
      'GitHub: 1 total',
      'Newsletters: 2 total',
      'Other: 2 total'
    ])
    expect(await zero.locator('img').getAttribute('src')).not.toMatch(/^https?:/)

    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 5_000 })
    const artifactDirectory = join(__dirname, '.artifacts')
    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'inbox-zero.png')
    await page.screenshot({ path })
    await testInfo.attach('inbox-zero', { path, contentType: 'image/png' })

    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('theme-picker').selectOption('dispatch-light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('theme-picker')).toHaveCount(0)
    const lightPath = join(artifactDirectory, 'inbox-zero-light.png')
    await page.screenshot({ path: lightPath })
    await testInfo.attach('inbox-zero-light', { path: lightPath, contentType: 'image/png' })

    await page.locator('[data-testid="inbox-zero-split"][data-split-id="fallback:other"]').click()
    await expect(zero).toHaveCount(0)
    await expect(page.getByTestId('thread-row')).toHaveCount(2)
  })
})

test.describe('account-scoped Inbox readiness', () => {
  test.use({ seed: 'fixtures/seed-two-accounts-inbox-ready.json' })

  test('switches between the reward and loading state using each account checkpoint', async ({ page }) => {
    await expect(page.getByTestId('account-menu')).toContainText('ready@attn.test')
    await expect(page.getByTestId('inbox-zero')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.attn?.sync.getInboxReady())).toBe(true)

    await page.keyboard.press('ControlOrMeta+2')
    await expect(page.getByTestId('account-menu')).toContainText('syncing@attn.test')
    await expect.poll(() => page.evaluate(() => window.attn?.sync.getInboxReady())).toBe(false)
    await expect(page.getByTestId('inbox-zero')).toHaveCount(0)
    await expect(page.getByTestId('thread-list-loading-initial')).toHaveText('Loading conversations…')

    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByTestId('account-menu')).toContainText('ready@attn.test')
    await expect(page.getByTestId('inbox-zero')).toBeVisible()
    await expect(page.getByTestId('thread-list-loading-initial')).toHaveCount(0)
  })
})

test.describe('partial Inbox metadata', () => {
  test.use({ seed: 'fixtures/seed-inbox-not-ready.json' })

  test('keeps the reward hidden while the Inbox metadata walk is incomplete', async ({ app, page }) => {
    await setSyncState(app, { phase: 'syncing', stage: 'metadata', threadsDone: 0 })

    await expect(page.getByTestId('inbox-zero')).toHaveCount(0)
    await expect(page.getByTestId('thread-list-loading-initial')).toHaveText('Loading conversations…')
    await expect(page.getByTestId('status-note')).toHaveAttribute('data-status', 'syncing')
    await expect(page.getByTestId('thread-list')).not.toContainText('Inbox empty')
  })
})

test.describe('partial Inbox bodies', () => {
  test.use({ seed: 'fixtures/seed-inbox-bodies.json' })

  test('waits for body-derived split classification', async ({ page }) => {
    await expect(page.getByTestId('inbox-zero')).toHaveCount(0)
    await expect(page.getByTestId('thread-list-loading-initial')).toHaveText('Loading conversations…')
    await expect(page.getByTestId('thread-list')).not.toContainText('Inbox empty')
  })
})

test.describe('Inbox metadata recovery', () => {
  test.use({ seed: 'fixtures/seed-inbox-recovery.json' })

  test('hides an existing reward as soon as metadata recovery starts', async ({ app, page }) => {
    await expect(page.getByTestId('inbox-zero')).toBeVisible()

    await setSyncState(app, { phase: 'syncing', stage: 'metadata', threadsDone: 0 })

    await expect.poll(() => page.evaluate(() => window.attn?.sync.getInboxReady())).toBe(false)
    await expect(page.getByTestId('inbox-zero')).toHaveCount(0)
    await expect(page.getByTestId('thread-list-loading-initial')).toHaveText('Loading conversations…')
  })
})
