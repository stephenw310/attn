import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('renders seeded mail through IPC and the real SQLite store', async ({ page, mainLog }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.first()).toContainText('Maya Lin')
  await expect(page.getByTestId('queue-readout')).toHaveText('4 to zero')
  await expect(page.getByTestId('account-menu')).toContainText('seed@attn.test')
  await expect(page.getByTestId('status-note')).not.toHaveText('mock data')

  expect(await page.evaluate(() => window.attn.mail.listThreads())).toHaveLength(8)
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(4)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('message-card').last()).toContainText(
    'I added the launch milestones and owner notes.'
  )
  await expect.poll(mainLog).toContain('[seed] loaded 8 threads for seed@attn.test')
})

test('relaunches against persisted seeded data without importing again', async ({ boot }) => {
  await expect((await boot.app.firstWindow()).getByTestId('thread-row')).toHaveCount(8)
  const { page } = await boot.relaunch()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
})
