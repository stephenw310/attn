import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('searches, applies, and undoes a user label', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toContainText('Maya Lin')
  await expect(first.getByTestId('label-chip')).toHaveCount(0)

  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')
  const picker = page.getByTestId('label-picker')
  const search = page.getByTestId('label-search')
  await expect(picker).toBeVisible()
  await expect(search).toBeFocused()
  await expect(picker.getByTestId('label-option')).toHaveCount(12)

  await search.fill('proj')
  const project = picker.getByTestId('label-option')
  await expect(project).toHaveCount(1)
  await expect(project).toContainText('projects')
  await expect(project).toHaveAttribute('data-state', 'off')
  await page.keyboard.press('Enter')

  await expect(project).toHaveAttribute('data-state', 'all')
  const projectChip = first.getByTestId('label-chip')
  await expect(projectChip).toHaveText('projects')
  const [chipBox, subjectBox] = await Promise.all([
    projectChip.boundingBox(),
    first.getByTestId('thread-subject').boundingBox()
  ])
  // Labels are set after the subject, in their own ink, so a long subject
  // never pushes them out of the row.
  expect(chipBox?.x).toBeGreaterThan(subjectBox?.x ?? 0)
  const [labelColor, subjectColor] = await Promise.all([
    projectChip.evaluate((element) => getComputedStyle(element).color),
    first.getByTestId('thread-subject').evaluate((element) => getComputedStyle(element).color)
  ])
  expect(labelColor).not.toBe(subjectColor)
  await expect(page.getByTestId('pending-count')).toContainText('1 letter waiting')

  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(first.getByTestId('label-chip')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('2 letters waiting')
})

test('keeps picker typing isolated and opens it over a conversation', async ({ page }, testInfo) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toContainText('Maya Lin')
  await first.click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('l')
  await expect(page.getByTestId('label-picker')).toBeVisible()
  await expect(page.getByTestId('pending-count')).toContainText('1 letter waiting')

  const search = page.getByTestId('label-search')
  await search.fill('s')
  await expect(first.getByTitle('Starred')).toBeHidden()
  await expect(page.getByTestId('pending-count')).toContainText('1 letter waiting')

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'label-picker.png')
  await page.screenshot({ path })
  await testInfo.attach('label-picker', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('label-picker')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})

test('shows existing user-label membership without system labels', async ({ page }) => {
  const receipt = page.getByTestId('thread-row').nth(1)
  await expect(receipt.getByTestId('label-chip')).toHaveText('receipts')
  await receipt.click()
  await page.keyboard.press('l')

  const options = page.getByTestId('label-option')
  await expect(options).toHaveCount(12)
  await expect(options.filter({ hasText: 'receipts' })).toHaveAttribute('data-state', 'all')
  await expect(options.filter({ hasText: 'projects' })).toHaveAttribute('data-state', 'off')
})

test('applies labels to the full bulk target set while the picker stays open', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await rows.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')

  await page.keyboard.press('l')
  const picker = page.getByTestId('label-picker')
  const projects = picker.getByTestId('label-option').filter({ hasText: 'projects' })
  await expect(projects).toHaveAttribute('data-state', 'some')
  await projects.click()

  await expect(picker).toBeVisible()
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(projects).toHaveAttribute('data-state', 'all')
  for (let index = 0; index < 3; index++) {
    await expect(rows.nth(index).getByTestId('label-chip').filter({ hasText: 'projects' })).toBeVisible()
  }

  await projects.click()
  await expect(projects).toHaveAttribute('data-state', 'off')
  for (let index = 0; index < 3; index++) {
    await expect(rows.nth(index).getByTestId('label-chip').filter({ hasText: 'projects' })).toHaveCount(0)
  }
})

test('refreshes the picker from an authoritative renamed label catalog', async ({ app, page }) => {
  const error = await app.evaluate(
    ({ ipcMain }, { channel, labels }) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(channel, {}, labels, resolve)),
    {
      channel: TEST_CHANNELS.reloadSeed,
      labels: [{ id: 'Label_2', name: 'active projects', type: 'user' }]
    }
  )
  if (error) throw new Error(error)

  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')
  const options = page.getByTestId('label-option')
  await expect(options).toHaveCount(1)
  await expect(options).toContainText('active projects')
})

test('wraps picker navigation at both ends and scrolls the highlight into view', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')

  const options = page.getByTestId('label-option')
  const scroller = page.getByTestId('label-options')
  await expect(options).toHaveCount(12)
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')

  // Wrapping backwards off the top lands on the last option, which is out of
  // view until the picker scrolls to it.
  await page.keyboard.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('data-highlighted', 'true')
  const bottomScroll = await scroller.evaluate((element) => element.scrollTop)
  expect(bottomScroll).toBeGreaterThan(0)

  await page.keyboard.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(bottomScroll)

  // Walking the full list forwards ends on the same last option and scroll.
  for (let index = 0; index < 11; index++) await page.keyboard.press('ArrowDown')
  await expect(options.last()).toHaveAttribute('data-highlighted', 'true')
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(bottomScroll)

  for (let index = 0; index < 11; index++) await page.keyboard.press('ArrowUp')
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')
  const [scrollerBox, firstBox] = await Promise.all([scroller.boundingBox(), options.first().boundingBox()])
  expect(firstBox?.y).toBeGreaterThanOrEqual(scrollerBox?.y ?? 0)
})

test('shows two labels on a row and counts the rest', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toContainText('Maya Lin')
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })

  for (const name of ['projects', 'receipts', 'design']) {
    await page.keyboard.press('l')
    const search = page.getByTestId('label-search')
    await search.fill(name)
    await expect(page.getByTestId('label-option')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('label-picker')).toHaveCount(0)
  }

  await expect(first.getByTestId('label-chip')).toHaveCount(2)
  await expect(first.getByTestId('label-overflow')).toContainText('+1')
  await expect(first.getByTestId('label-overflow')).toContainText('1 more label: design')
})

test('keeps the subject readable beside labels at the narrowest window', async ({ app, page }) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 600))
  const first = page.getByTestId('thread-row').first()
  await expect(first).toContainText('Maya Lin')
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })

  for (const name of ['projects', 'receipts']) {
    await page.keyboard.press('l')
    await page.getByTestId('label-search').fill(name)
    await expect(page.getByTestId('label-option')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('label-picker')).toHaveCount(0)
  }

  await expect(first.getByTestId('label-chip')).toHaveCount(2)
  // Labels give way before the subject does: the subject is what a reader scans,
  // so it must still fit inside the span that clips the line.
  const line = await first.evaluate((row) => {
    const subject = row.querySelector('[data-testid="thread-subject"]')
    const clip = subject?.parentElement
    if (!subject || !clip) return null
    return {
      subjectRight: subject.getBoundingClientRect().right,
      clipRight: clip.getBoundingClientRect().right,
      clipWidth: clip.getBoundingClientRect().width
    }
  })
  expect(line).not.toBeNull()
  expect(line?.subjectRight ?? 0).toBeLessThanOrEqual((line?.clipRight ?? 0) + 1)
  expect(line?.clipWidth ?? 0).toBeGreaterThan(160)
})
