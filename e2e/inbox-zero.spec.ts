import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import type { SyncState } from '../src/shared/mail'
import { expect, test } from './electron'

async function setSyncState(app: ElectronApplication, state: SyncState): Promise<void> {
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.state), {
    channel: TEST_CHANNELS.setSyncState,
    state
  })
}

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
      'Calendar: 2',
      'GitHub: 1',
      'Newsletters: 2',
      'Other: 2'
    ])
    expect(await zero.locator('img').getAttribute('src')).not.toMatch(/^https?:/)

    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 5_000 })
    const artifactDirectory = join(__dirname, '.artifacts')
    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'inbox-zero.png')
    await page.screenshot({ path })
    await testInfo.attach('inbox-zero', { path, contentType: 'image/png' })

    await page.locator('[data-testid="inbox-zero-split"][data-split-id="fallback:other"]').click()
    await expect(zero).toHaveCount(0)
    await expect(page.getByTestId('thread-row')).toHaveCount(2)
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
