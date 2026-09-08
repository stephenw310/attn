import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { emitSeam, setSyncState } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('renders seeded mail through IPC and the real SQLite store', async ({ page, mainLog }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.first()).toContainText('Maya Lin')
  await expect(page.getByTestId('queue-readout')).toHaveCount(0)
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

  const firstPage = await page.evaluate(() => window.attn.mail.listThreadPage('inbox'))
  expect(firstPage.rows).toHaveLength(8)
  expect(firstPage.nextCursor).toBeNull()
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(4)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('message-card').last()).toContainText(
    'I added the launch milestones and owner notes.'
  )
  await expect.poll(mainLog).toContain('[seed] loaded 10 threads for seed@attn.test')
  await expect.poll(mainLog).toContain('[sync] backfill stages skipped for seeded accounts seed@attn.test')
  expect(mainLog()).not.toContain('[sync] history poller started')
})

test('exposes threading headers and idempotent contact ranking over IPC', async ({ app, page }) => {
  const replyConversation = await page.evaluate(() =>
    window.attn.mail.getConversation('t-roadmap', false, 'normal')
  )
  // Two readable messages plus the trashed message kept as a marker (F3); the
  // Gmail draft in the fixture still never surfaces.
  expect(replyConversation?.messages).toHaveLength(3)
  expect(replyConversation?.messages[2]).toMatchObject({ id: 'm-roadmap-trash', trashed: true })
  expect(replyConversation?.messages[1]).toMatchObject({
    rfcMessageId: '<roadmap-reply@example.com>',
    references: ['<roadmap-root@example.com>'],
    recipients: {
      replyTo: [{ name: 'Maya Lin', email: 'maya+roadmap@example.com' }]
    }
  })

  const conversation = await page.evaluate(() =>
    window.attn.mail.getConversation('t-sent-history', false, 'normal')
  )
  expect(conversation?.messages).toHaveLength(1)
  expect(conversation?.messages[0]).toMatchObject({
    fromName: 'Me',
    fromEmail: 'seed@attn.test',
    rfcMessageId: '<sent-history@attn.test>',
    references: ['<roadmap-root@example.com>', '<roadmap-reply@example.com>']
  })

  const before = await page.evaluate(() => window.attn.contacts.search('maya'))
  expect(before[0]).toMatchObject({ name: 'Maya Lin', email: 'maya@example.com' })
  expect(await page.evaluate(() => window.attn.contacts.search('pri'))).toEqual([
    expect.objectContaining({ name: 'Priya Raman', email: 'priya@example.com' })
  ])
  expect(await page.evaluate(() => window.attn.contacts.search('seed@attn.test'))).toEqual([])
  expect(await page.evaluate(() => window.attn.contacts.search(''))).toHaveLength(8)

  // Non-ASCII case folding: "ürsula" appears in neither the address nor any
  // ASCII-lowercased form of the name, so this only matches if the store folded
  // the name in JS rather than through SQLite's ASCII-only lower().
  expect(await page.evaluate(() => window.attn.contacts.search('ürsula'))).toEqual([
    expect.objectContaining({ name: 'Ürsula Groß', email: 'ursula@example.com' })
  ])
  expect(await page.evaluate(() => window.attn.contacts.search('groß'))).toEqual([
    expect.objectContaining({ email: 'ursula@example.com' })
  ])

  // Prefix precedence — the invariant candidate truncation used to break. "ma"
  // prefixes maya@ while genuinely infix-matching amara@ and Priya Raman, so a
  // regression that ranks infix alongside prefix fails here. The truncation
  // itself needs >200 matches to reproduce and is covered by construction: the
  // prefix scan is uncapped, only the infix fill is bounded.
  const prefixFirst = await page.evaluate(() => window.attn.contacts.search('ma'))
  expect(prefixFirst[0]).toMatchObject({ email: 'maya@example.com' })

  // Replay the exact same snapshots through the production persistence path.
  // Contribution PKs make this a no-op for aggregate frequency.
  await emitSeam(app, TEST_CHANNELS.reloadSeed)
  const after = await page.evaluate(() => window.attn.contacts.search('maya'))
  expect(after[0]).toMatchObject({ name: 'Maya Lin', email: 'maya@example.com' })
  expect(after[0].score).toBeCloseTo(before[0].score, 5)

  // Removing the only sent contribution drops Priya from the projection while
  // preserving Maya's independent received-mail contributions.
  await emitSeam(app, TEST_CHANNELS.deleteThread, 't-sent-history')
  expect(await page.evaluate(() => window.attn.contacts.search('pri'))).toEqual([])
  expect(await page.evaluate(() => window.attn.contacts.search('maya'))).toEqual([
    expect.objectContaining({ name: 'Maya Lin', email: 'maya@example.com' })
  ])
})

test('shows phased sync progress and keeps error details behind an accessible control', async ({
  app,
  page
}) => {
  const status = page.getByTestId('status-note')
  await expect(status).toHaveAttribute('data-status', 'live')

  const content = page.getByTestId('status-content')
  await expect(content).toHaveText('Live')
  await setSyncState(app, { phase: 'syncing', stage: 'bodies', threadsDone: 428 })
  await expect(content).toHaveText('Syncing')
  await expect(content).toHaveAttribute('data-tooltip', 'Recent mail: 428 processed')
  await expect(content).toHaveCSS('height', '28px')
  await setSyncState(app, {
    phase: 'indexing',
    stage: 'lifetime',
    threadsDone: 750,
    threadsTotal: 2000,
    reason: 'running'
  })
  await expect(content).toHaveText('Indexing')
  await expect(content).toHaveAttribute('data-tooltip', /750 of 2,000 threads indexed/)
  await content.click()
  await expect(page.getByRole('dialog', { name: 'Sync details', exact: true })).toContainText('750 of 2,000')
  await page.keyboard.press('Escape')
  // Keep denominator and retry evidence available in the compact status details.
  await setSyncState(app, {
    phase: 'indexing',
    stage: 'lifetime',
    threadsDone: 86_200,
    threadsTotal: 201,
    reason: 'running'
  })
  await expect(content).toHaveAttribute('data-tooltip', /86,200 threads indexed/)
  await expect(content).not.toHaveAttribute('data-tooltip', /of 201/)
  await setSyncState(app, {
    phase: 'indexing',
    stage: 'lifetime',
    threadsDone: 750,
    threadsTotal: 2_000,
    etaMs: 12 * 60_000,
    reason: 'quota-wait',
    waitMs: 1_000
  })
  await expect(content).toHaveAttribute(
    'data-tooltip',
    /Quota pacing · 750 of 2,000 threads indexed · 12 min remaining/
  )
  await setSyncState(app, {
    phase: 'indexing',
    stage: 'lifetime',
    threadsDone: 2_400,
    reason: 'retry-wait',
    waitMs: 15_000,
    message: 'rate limited'
  })
  await expect(content).toHaveAttribute(
    'data-tooltip',
    /Indexing paused · retrying soon · 2,400 threads indexed/
  )
  await setSyncState(app, { phase: 'checking' })
  await expect(content).toHaveText('Checking')
  await setSyncState(app, { phase: 'offline', message: 'fetch failed' })
  await expect(content).toHaveText('Offline')

  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  const message = `gmail history failed (403): ${'q'.repeat(300)}`
  await setSyncState(app, { phase: 'error', message })
  await expect(status).toContainText('Error')
  await expect(status).not.toContainText(message)
  await expect(status).toHaveAttribute('data-tooltip', message)

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
