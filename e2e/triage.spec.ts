import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { goTo } from './nav'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('archives with auto-advance and undoes durably', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.nth(1)).toContainText('Northstar Books')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(7)
  await expect(rows.first()).toContainText('Northstar Books')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('pending-count')).toContainText('1 letter waiting')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('2 letters waiting')
})

test('self-heals a permanently rejected archive and invalidates its undo', async ({ app, page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.threadId), {
    channel: TEST_CHANNELS.failNextAction,
    threadId: 't-roadmap'
  })

  await page.keyboard.press('e')

  await expect(page.getByTestId('toast')).toHaveText(
    "Couldn't archive 'Q3 roadmap review' — it's back in your inbox."
  )
  await expect(rows).toHaveCount(8)
  await expect(rows.filter({ hasText: 'Q3 roadmap review' })).toHaveCount(1)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(rows.filter({ hasText: 'Q3 roadmap review' })).toHaveCount(1)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)
})

test('makes a failed token refresh visibly reconnectable', async ({ app, page, mainLog }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.threadId), {
    channel: TEST_CHANNELS.failNextActionAuth,
    threadId: 't-roadmap'
  })

  await page.keyboard.press('e')

  await expect.poll(mainLog).toContain('token refresh returned invalid_grant for seed@attn.test')
  // The log line is main's; the readout is the renderer's, and it arrives on a
  // later push. Polling the log is the weaker precondition of the two, so give
  // the UI its own window rather than racing the default one under load.
  await expect(page.getByTestId('action-reconnect')).toContainText('1 held. Reconnect Google', {
    timeout: 15_000
  })
  await expect(page.getByTestId('paused-count')).toContainText('1 held')
  // The pending readout still counts the row: a paused action is queued work,
  // not a separate category, and the reconnect control sits beside it rather
  // than replacing it.
  await expect(page.getByTestId('pending-count')).toContainText('1 letter waiting')

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'auth-paused.png')
  await page.screenshot({ path })
  await testInfo.attach('auth-paused', { path, contentType: 'image/png' })

  await page.getByTestId('action-reconnect').click()
  await expect(page.getByTestId('action-reconnect')).toHaveCount(0)
  await expect(page.getByTestId('paused-count')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveText('Google reconnected — 1 pending change is retrying.')
})

test('animates a marked-done row before removing it', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  const nextRow = rows.filter({ hasText: 'Northstar Books' })
  const nextRowStart = await nextRow.evaluate((element) => element.getBoundingClientRect().y)

  await page.keyboard.press('e')
  await expect(rows.first()).toHaveAttribute('data-exiting', 'true')
  await expect(rows.first()).toHaveClass(/app-thread-exit/)
  await expect(nextRow).toHaveAttribute('data-selected', 'true')
  await expect(rows).toHaveCount(7)
  // Poll the collapse rather than sampling one frame: software-rendered
  // containers pace animation frames unevenly, and a single mid-animation
  // sample fails there on unmodified main (verified 2026-08-28).
  await expect
    .poll(() => nextRow.evaluate((element) => element.getBoundingClientRect().y))
    .toBeLessThan(nextRowStart - 20)
  const firstToastId = await page.getByTestId('toast').getAttribute('data-toast-id')

  await page.keyboard.press('e')
  await expect(rows.first()).toHaveAttribute('data-exiting', 'true')
  await expect(rows).toHaveCount(6)
  await expect(page.getByTestId('toast')).not.toHaveAttribute('data-toast-id', firstToastId ?? '')
})

test('does not drop rapid archives or an undo during the exit animation', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  const stableRow = rows.nth(2)
  const stableX = await stableRow.evaluate((element) => element.getBoundingClientRect().x)

  await page.keyboard.press('e')
  await page.keyboard.press('e')
  const framePositions = await stableRow.evaluate(
    (element) =>
      new Promise<Array<{ rowX: number; listScrollLeft: number; windowScrollX: number }>>((resolve) => {
        const positions: Array<{ rowX: number; listScrollLeft: number; windowScrollX: number }> = []
        const list = element.closest('[data-testid="thread-list"]')
        const startedAt = performance.now()
        const sample = (): void => {
          positions.push({
            rowX: element.getBoundingClientRect().x,
            listScrollLeft: list?.scrollLeft ?? -1,
            windowScrollX: window.scrollX
          })
          if (performance.now() - startedAt < 650) requestAnimationFrame(sample)
          else resolve(positions)
        }
        requestAnimationFrame(sample)
      })
  )
  expect(framePositions.every(({ rowX }) => Math.abs(rowX - stableX) < 1)).toBe(true)
  expect(
    framePositions.every(({ listScrollLeft, windowScrollX }) => listScrollLeft === 0 && windowScrollX === 0)
  ).toBe(true)
  await expect(page.getByTestId('pending-count')).toContainText('2 letters waiting')
  await expect(rows).toHaveCount(6)

  await page.keyboard.press('e')
  await page.keyboard.press('z')
  await expect(page.getByTestId('pending-count')).toContainText('4 letters waiting')
  await expect(rows).toHaveCount(6)
})

test('selects a range and archives it as one undoable bulk action', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)

  await rows.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await page.keyboard.press('k')
  await page.keyboard.press('k')

  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(1)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(2)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true')
  // Only the row the keyboard is on carries the torn highlight, even though
  // all three are checked.
  await expect
    .poll(() =>
      rows.evaluateAll((items) =>
        items
          .slice(0, 3)
          .map((item) => item.querySelectorAll('[data-testid="thread-selection-strip"]').length)
      )
    )
    .toEqual([0, 0, 1])

  // Reader Escape always returns to the list; a second list Escape clears selection.
  await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(rows.locator('[data-checked="true"]')).toHaveCount(0)

  await page.keyboard.press('k')
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('3 letters waiting')
  await expect(rows.filter({ hasText: 'Q3 roadmap review' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Your receipt' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Design notes' })).toHaveCount(0)

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('6 letters waiting')
  await expect(rows.filter({ hasText: 'Q3 roadmap review' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Your receipt' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Design notes' })).toHaveCount(1)
})

test('extends disjoint selections without dropping earlier rows', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')

  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(1)).not.toHaveAttribute('data-checked')
  await expect(rows.nth(2)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(3)).toHaveAttribute('data-checked', 'true')
})

test('extends a range while the full-window reader is open', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()

  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(rows.nth(2)).toHaveAttribute('data-checked', 'true')
})

test('keeps the range anchor selected when toggling a row off', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('x')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')

  await page.keyboard.press('Shift+k')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(1)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(2)).not.toHaveAttribute('data-checked')
})

test('shrinks the range when Shift+K walks back over an overshoot', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')

  await page.keyboard.press('Shift+k')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(rows.nth(2)).not.toHaveAttribute('data-checked')
  await page.keyboard.press('Shift+k')
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(1)).not.toHaveAttribute('data-checked')
})

test('extends from the cursor after the anchor row is deselected', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  for (let i = 0; i < 5; i++) await page.keyboard.press('j')
  await page.keyboard.press('x')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.keyboard.press('x')
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')

  // The anchor died with row 5, so the range starts from the cursor — not from
  // the surviving row 0, which would swallow everything in between.
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(3)).not.toHaveAttribute('data-checked')
  await expect(rows.nth(5)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(6)).toHaveAttribute('data-checked', 'true')
})

test('keeps the range anchor on its thread when undo reorders the list', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(7)
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(rows.nth(2)).not.toHaveAttribute('data-checked')
  await expect(rows.nth(3)).toHaveAttribute('data-checked', 'true')
  await expect(rows.nth(4)).toHaveAttribute('data-checked', 'true')
})

test('derives bulk star and unread direction from the selected rows', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect(rows.nth(2).getByTitle('Starred')).toBeVisible()
  await page.keyboard.press('x')
  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await page.keyboard.press('s')
  await expect(rows.nth(2).getByTitle('Starred')).toBeHidden()

  await page.keyboard.press('j')
  await expect(rows.nth(1)).not.toHaveAttribute('data-unread')
  await page.keyboard.press('x')
  await page.keyboard.press('k')
  await page.keyboard.press('u')
  await expect(rows.nth(1)).toHaveAttribute('data-unread', 'true')
})

test('toggles star and unread, then trashes', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toHaveAttribute('data-unread', 'true')
  await page.getByTestId('status-note').click()
  await page.keyboard.press('s')
  const star = first.getByTitle('Starred')
  await expect(star).toBeVisible()
  // The star sits in the fixed marks column after the subject, where it cannot
  // shift the subject or the time as it appears and disappears.
  expect(
    await first.evaluate((row) => {
      const star = row.querySelector('[title="Starred"]')
      const subject = row.querySelector('[data-testid="thread-subject"]')
      const time = row.querySelector('[data-testid="thread-time"]')
      return Boolean(
        star &&
          subject &&
          time &&
          subject.compareDocumentPosition(star) & Node.DOCUMENT_POSITION_FOLLOWING &&
          star.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    })
  ).toBe(true)
  await page.keyboard.press('u')
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('#')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await expect(page.getByTestId('pending-count')).toContainText('3 letters waiting')
})

// F2's airplane-mode criterion is twenty archives, not a handful (GAP-4), and
// twenty threads is more than the shared inbox fixture holds — hence a seed of
// its own for this one test.
const OFFLINE_ARCHIVE_COUNT = 20
const OFFLINE_SEED_THREADS = 22

test.describe('offline replay at the F2 criterion', () => {
  test.use({ seed: 'fixtures/seed-offline-replay.json' })

  test('keeps offline actions across relaunch without reseeding', async ({ boot }) => {
    let page = await boot.app.firstWindow()
    const rows = page.getByTestId('thread-row')
    await expect(rows).toHaveCount(OFFLINE_SEED_THREADS)
    // Each archive is observed on its own: the row leaves the inbox before the
    // next keystroke, so twenty distinct intents reach the queue.
    for (let archived = 1; archived <= OFFLINE_ARCHIVE_COUNT; archived++) {
      await page.keyboard.press('e')
      await expect(rows).toHaveCount(OFFLINE_SEED_THREADS - archived)
      await expect(page.getByTestId('pending-count')).toContainText(
        `${archived} letter${archived === 1 ? '' : 's'} waiting`
      )
    }
    ;({ page } = await boot.relaunch())
    await expect(page.getByTestId('thread-row')).toHaveCount(OFFLINE_SEED_THREADS - OFFLINE_ARCHIVE_COUNT)
    await expect(page.getByTestId('pending-count')).toContainText(`${OFFLINE_ARCHIVE_COUNT} letters waiting`)
    // Every archive applied to its own thread and none was lost: All Mail
    // still holds the whole seed after the restart.
    await goTo(page, 'a')
    await expect(page.getByTestId('thread-row')).toHaveCount(OFFLINE_SEED_THREADS)
    expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
  })
})

test('triages from the reader and advances the open conversation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await page.keyboard.press('e')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await page.keyboard.press('z')
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
})

test('keeps explicit unread and undo stable while the reader is open', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toHaveAttribute('data-unread', 'true')
  await first.click()
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('u')
  await expect(first).toHaveAttribute('data-unread', 'true')
  await page.keyboard.press('z')
  await expect(first).not.toHaveAttribute('data-unread')
})

test('keeps a valid selection after navigating an empty inbox', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await rows.first().click()
  for (let remaining = 7; remaining >= 0; remaining--) {
    await page.keyboard.press('e')
    await expect(rows).toHaveCount(remaining)
  }
  await page.keyboard.press('j')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(0)
})

test('extends the selection with Shift+Arrow in the list and in the reader', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const count = page.getByTestId('selection-count')

  await page.keyboard.press('x')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(count).toHaveText('2 selected')

  // Shift+Arrow keeps extending inside the reader, where a bare arrow scrolls.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(count).toHaveText('3 selected')
  await page.keyboard.press('Shift+ArrowUp')
  await expect(count).toHaveText('2 selected')

  // A bare arrow in the reader scrolls the conversation instead of navigating.
  const position = page.getByTestId('conversation-position')
  const before = await position.textContent()
  await page.keyboard.press('ArrowDown')
  await expect(position).toHaveText(before ?? '')
})
