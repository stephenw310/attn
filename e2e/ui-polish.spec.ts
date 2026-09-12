import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-splits.json' })

test('exposes layout shortcuts and fast icon hints', async ({ page }) => {
  await expect(page.getByTestId('thread-list')).toBeVisible()
  const search = page.getByTestId('search-open')
  await search.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Search mail (/)')
  await expect(search).not.toHaveAttribute('title')
  await page.mouse.move(0, 0)
  const sidebar = await page.getByTestId('mail-sidebar').boundingBox()
  const footer = await page.getByTestId('mail-footer').boundingBox()
  expect(footer?.x).toBe((sidebar?.x ?? 0) + (sidebar?.width ?? 0))
  expect((sidebar?.y ?? 0) + (sidebar?.height ?? 0)).toBe((footer?.y ?? 0) + (footer?.height ?? 0))
  await page.keyboard.press('ControlOrMeta+Shift+B')
  await expect(page.getByTestId('mail-footer')).toHaveCount(0)
  await expect(page.getByTestId('mail-header').getByTestId('status-note')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+B')
  await expect(page.getByTestId('mail-footer')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+S')
  await expect(page.getByTestId('split-rules')).toBeVisible()
  await page.keyboard.press('Escape')
  const composer = new ComposerPage(page)
  await composer.openNew()
  await expect(page.getByTestId('sidebar-toggle')).toHaveCount(0)
  await expect(page.getByTestId('footer-toggle')).toHaveCount(0)
  await expect(page.getByTestId('status-note')).toBeVisible()
  await expect(page.getByTestId('composer-to')).toHaveCSS('min-height', '44px')
  await expect(page.getByTestId('composer-subject')).toHaveAttribute('placeholder', 'Add a subject')
  await expect(page.getByTestId('composer-to').locator('input')).not.toHaveAttribute('placeholder')
  const attach = page.getByTestId('composer-attach')
  await attach.hover()
  await expect(page.getByRole('tooltip')).toContainText('Attach files', { timeout: 500 })
  await page.mouse.move(0, 0)
  await page.getByTestId('composer-follow-up').focus()
  await expect(page.getByRole('tooltip')).toContainText('Remind me if no reply')
})

test('separates inline drafts and keeps the reminder popup unobstructed', async ({ page }) => {
  await page.getByTestId('thread-row').first().click()
  const composer = new ComposerPage(page)
  await composer.openReply()
  const source = page.getByTestId('conversation-message').filter({
    has: page.getByTestId('message-cursor')
  })
  const sourceBox = await source.boundingBox()
  const draftBox = await composer.root.boundingBox()
  expect(draftBox?.y).toBeGreaterThan((sourceBox?.y ?? 0) + (sourceBox?.height ?? 0))
  await page.getByTestId('composer-follow-up').click()
  const popup = page.getByTestId('follow-up-popover')
  await expect(popup).toBeVisible()
  expect(
    await popup.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return (
        box.left >= 0 &&
        box.right <= innerWidth &&
        box.top >= 0 &&
        box.bottom <= innerHeight &&
        element.contains(document.elementFromPoint(box.right - 8, box.top + 8))
      )
    })
  ).toBe(true)
  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  await page.screenshot({ path: join(__dirname, '.artifacts/inline-reminder-card.png') })
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(composer.root).toBeVisible()
})

test('outside reminder clicks preserve editor focus while Escape and selection restore the trigger', async ({
  page
}) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  const trigger = page.getByTestId('composer-follow-up')
  const popup = page.getByTestId('follow-up-popover')
  await trigger.click()
  await expect(popup).toBeVisible()
  await composer.editor.click({ position: { x: 20, y: 20 } })
  await expect(popup).toHaveCount(0)
  await expect(composer.editor).toBeFocused()
  await page.keyboard.type('Focus stays here')
  await expect(composer.editor).toContainText('Focus stays here')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByTestId('follow-up-preset-3d').click()
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
