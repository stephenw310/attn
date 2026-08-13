import type { ElectronApplication } from '@playwright/test'
import type { SyncState } from '../src/shared/mail'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function setSyncState(app: ElectronApplication, state: SyncState): Promise<void> {
  await app.evaluate(({ ipcMain }, next) => ipcMain.emit('attn:test:setSyncState', {}, next), state)
}

test('renders seeded mail through IPC and the real SQLite store', async ({ page, mainLog }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.first()).toContainText('Maya Lin')
  await expect(page.getByTestId('queue-readout')).toHaveText('4 to zero')
  await expect(page.getByTestId('account-menu')).toContainText('seed@attn.test')
  await expect(page.getByTestId('status-note')).toContainText('Live')
  await expect(page.getByTestId('status-note')).toHaveAttribute('data-status', 'live')
  const statusBox = await page.getByTestId('status-note').boundingBox()
  const contentBox = await page.getByTestId('status-content').boundingBox()
  expect(statusBox).not.toBeNull()
  expect(contentBox).not.toBeNull()
  expect(
    Math.abs((statusBox?.x ?? 0) + (statusBox?.width ?? 0) - (contentBox?.x ?? 0) - (contentBox?.width ?? 0))
  ).toBeLessThan(1)

  expect(await page.evaluate(() => window.attn.mail.listThreads())).toHaveLength(8)
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(4)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('message-card').last()).toContainText(
    'I added the launch milestones and owner notes.'
  )
  await expect.poll(mainLog).toContain('[seed] loaded 8 threads for seed@attn.test')
  expect(mainLog()).not.toContain('[sync] history poller started')
})

test('shows phased sync progress and keeps error details behind an accessible control', async ({
  app,
  page
}) => {
  const status = page.getByTestId('status-note')
  await expect(status).toHaveAttribute('data-status', 'live')

  await setSyncState(app, { phase: 'syncing', stage: 'bodies', threadsDone: 428 })
  await expect(status).toContainText('Syncing · Recent mail')
  await expect(status).toHaveAttribute('data-status', 'syncing')
  await expect(status).toHaveAttribute('title', 'Syncing · Recent mail — 428 processed')
  const progress = page.getByTestId('sync-progress')
  await expect(progress).toHaveAttribute('aria-valuenow', '2')
  await expect(progress.locator('[data-phase-state]')).toHaveCount(3)
  await expect(progress.locator('[data-phase-state]').nth(0)).toHaveAttribute('data-phase-state', 'complete')
  await expect(progress.locator('[data-phase-state]').nth(1)).toHaveAttribute('data-phase-state', 'active')

  await setSyncState(app, { phase: 'offline', message: 'fetch failed' })
  await expect(status).toContainText('Offline')
  await expect(status).toContainText('Local mail available')
  await expect(status).toHaveAttribute('data-status', 'offline')

  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  const message = `gmail history failed (403): ${'q'.repeat(300)}`
  await setSyncState(app, { phase: 'error', message })
  await expect(status).toContainText('Error')
  await expect(status).not.toContainText(message)
  await expect(status).toHaveAttribute('title', message)

  await page.getByTestId('status-error-button').click()
  const details = page.getByTestId('status-error-details')
  await expect(details).toBeVisible()
  const errorMessage = page.getByTestId('status-error-message')
  await expect(errorMessage).toHaveText(message)
  expect(await errorMessage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(page.getByTestId('status-copy-error')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)

  await page.getByTestId('status-error-button').click()
  await page.getByTestId('status-retry').click()
  await expect(status).toHaveAttribute('data-status', 'offline')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(status).toHaveAttribute('data-status', 'live')
})

test('relaunches against persisted seeded data without importing again', async ({ boot }) => {
  await expect((await boot.app.firstWindow()).getByTestId('thread-row')).toHaveCount(8)
  const { page } = await boot.relaunch()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
})
