import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('archives with auto-advance and undoes durably', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.nth(1)).toContainText('Northstar Books')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(7)
  await expect(rows.first()).toContainText('Northstar Books')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')
})

test('animates a marked-done row before removing it', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)

  await page.keyboard.press('e')
  await expect(rows.first()).toHaveAttribute('data-exiting', 'true')
  await expect(rows.first()).toHaveClass(/app-thread-exit/)
  await expect(rows).toHaveCount(7)
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
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')
  await expect(rows).toHaveCount(6)

  await page.keyboard.press('e')
  await page.keyboard.press('z')
  await expect(page.getByTestId('pending-count')).toContainText('4 pending')
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
  await expect
    .poll(() =>
      rows.evaluateAll((items) => {
        const borders = items.slice(0, 3).map((item) => getComputedStyle(item).borderLeftColor)
        return [borders[0] === 'rgba(0, 0, 0, 0)', borders[1] === 'rgba(0, 0, 0, 0)', borders[2]]
      })
    )
    .toEqual([true, true, 'rgb(255, 178, 36)'])

  // Open a read conversation so this assertion isolates selection clearing
  // from the separate open-marks-read behavior.
  await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  await expect(rows.locator('[data-checked="true"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-pane')).toHaveCount(0)

  await page.keyboard.press('k')
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('Shift+j')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')
  await expect(rows.filter({ hasText: 'Q3 roadmap review' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Your receipt' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Design notes' })).toHaveCount(0)

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('6 pending')
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

test('extends a range while the reading pane has message focus', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-pane')).toHaveAttribute('data-split-focus', 'true')

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
  await expect(rows.nth(2).getByTitle('Starred')).toHaveCount(0)

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
  expect(
    await first.evaluate((row) => {
      const star = row.querySelector('[title="Starred"]')
      const subject = row.querySelector('[data-testid="thread-subject"]')
      return Boolean(
        star && subject && star.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    })
  ).toBe(true)
  await page.keyboard.press('u')
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('#')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')
})

test('keeps offline actions across relaunch without reseeding', async ({ boot }) => {
  let page = await boot.app.firstWindow()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('e')
    await expect(page.getByTestId('thread-row')).toHaveCount(7 - i)
  }
  ;({ page } = await boot.relaunch())
  await expect(page.getByTestId('thread-row')).toHaveCount(5)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')
  expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
})

test('triages from the pane and advances the open conversation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await page.keyboard.press('e')
  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await page.keyboard.press('z')
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
})

test('keeps explicit unread and undo stable while the pane is open', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toHaveAttribute('data-unread', 'true')
  await first.click()
  await page.keyboard.press('Enter')
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('u')
  await expect(first).toHaveAttribute('data-unread', 'true')
  await page.keyboard.press('z')
  await expect(first).not.toHaveAttribute('data-unread')
})

test('does not run destructive shortcuts with command modifiers', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('Meta+e')
  await page.keyboard.press('Control+u')
  await page.keyboard.press('Alt+e')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)
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
