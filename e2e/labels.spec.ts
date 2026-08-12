import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
  expect(chipBox?.x).toBeLessThan(subjectBox?.x ?? 0)
  const projectColor = await projectChip.evaluate((element) => getComputedStyle(element).backgroundColor)
  const receiptColor = await page
    .getByTestId('thread-row')
    .nth(1)
    .getByTestId('label-chip')
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(projectColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(projectColor).not.toBe(receiptColor)
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(first.getByTestId('label-chip')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')
})

test('keeps picker typing isolated and opens it over a conversation', async ({ page }, testInfo) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toContainText('Maya Lin')
  await first.click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('l')
  await expect(page.getByTestId('label-picker')).toBeVisible()
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  const search = page.getByTestId('label-search')
  await search.fill('s')
  await expect(first.getByTitle('Starred')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

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

test('scrolls the highlighted option into view during keyboard navigation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')

  const options = page.getByTestId('label-option')
  const scroller = page.getByTestId('label-options')
  await expect(options).toHaveCount(12)
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')

  for (let index = 0; index < 11; index++) await page.keyboard.press('ArrowDown')

  await expect(options.last()).toHaveAttribute('data-highlighted', 'true')
  const bottomScroll = await scroller.evaluate((element) => element.scrollTop)
  expect(bottomScroll).toBeGreaterThan(0)

  for (let index = 0; index < 11; index++) await page.keyboard.press('ArrowUp')

  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(bottomScroll)
  const [scrollerBox, firstBox] = await Promise.all([scroller.boundingBox(), options.first().boundingBox()])
  expect(firstBox?.y).toBeGreaterThanOrEqual(scrollerBox?.y ?? 0)
})

test('wraps keyboard navigation across the ends of the label list', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')

  const options = page.getByTestId('label-option')
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')

  await page.keyboard.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('data-highlighted', 'true')

  await page.keyboard.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('data-highlighted', 'true')
})
