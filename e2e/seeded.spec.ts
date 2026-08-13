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
  await expect.poll(mainLog).toContain('[seed] loaded 9 threads for seed@attn.test')
  await expect.poll(mainLog).toContain('[sync] sent stage skipped for seeded account seed@attn.test')
  expect(mainLog()).not.toContain('[sync] history poller started')
})

test('exposes threading headers and idempotent contact ranking over IPC', async ({ app, page }) => {
  const conversation = await page.evaluate(() => window.attn.mail.getConversation('t-sent-history'))
  expect(conversation?.messages).toHaveLength(1)
  expect(conversation?.messages[0]).toMatchObject({
    rfcMessageId: '<sent-history@attn.test>',
    references: ['<roadmap-root@example.com>', '<roadmap-reply@example.com>']
  })

  const before = await page.evaluate(() => window.attn.contacts.search('maya'))
  expect(before[0]).toMatchObject({ name: 'Maya Lin', email: 'maya@example.com' })
  expect(await page.evaluate(() => window.attn.contacts.search('pri'))).toEqual([
    expect.objectContaining({ name: 'Priya Raman', email: 'priya@example.com' })
  ])
  expect(await page.evaluate(() => window.attn.contacts.search('seed@attn.test'))).toEqual([])

  // Replay the exact same snapshots through the production persistence path.
  // Contribution PKs make this a no-op for aggregate frequency.
  await app.evaluate(({ ipcMain }) => ipcMain.emit('attn:test:reloadSeed'))
  const after = await page.evaluate(() => window.attn.contacts.search('maya'))
  expect(after[0]).toMatchObject({ name: 'Maya Lin', email: 'maya@example.com' })
  expect(after[0].score).toBeCloseTo(before[0].score, 5)
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
  await expect(progress.locator('[data-phase-state]')).toHaveCount(4)
  await expect(progress.locator('[data-phase-state]').nth(0)).toHaveAttribute('data-phase-state', 'complete')
  await expect(progress.locator('[data-phase-state]').nth(1)).toHaveAttribute('data-phase-state', 'active')

  await setSyncState(app, { phase: 'syncing', stage: 'sent', threadsDone: 512 })
  await expect(status).toContainText('Syncing · Sent mail')
  await expect(progress).toHaveAttribute('aria-valuenow', '3')

  // An incremental poll is not a backfill phase: no stage label, no progress bar.
  await setSyncState(app, { phase: 'checking' })
  await expect(status).toContainText('Checking mail')
  await expect(status).toContainText('Looking for new mail')
  await expect(status).toHaveAttribute('data-status', 'checking')
  await expect(status).toHaveAttribute('title', 'Checking mail — Looking for new mail')
  await expect(page.getByTestId('sync-progress')).toHaveCount(0)

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
