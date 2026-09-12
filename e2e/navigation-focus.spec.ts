import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function expectInsetFocus(control: Locator): Promise<void> {
  await expect(control).toBeFocused()
  await expect(control).toHaveCSS('outline-style', 'solid')
  await expect(control).toHaveCSS('outline-width', '2px')
  await expect(control).toHaveCSS('outline-offset', '-2px')
}

async function captureFocus(page: Page, region: Locator, name: string): Promise<void> {
  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`${colorScheme}$`))
    await region.screenshot({ path: join(__dirname, `.artifacts/focus-${name}-${colorScheme}.png`) })
  }
}

test('Tab moves through mailboxes without changing the selected destination', async ({ page }) => {
  const mailboxes = page.getByTestId('sidebar-mailbox')
  await mailboxes.filter({ hasText: 'Inbox' }).click()
  await page.keyboard.press('Tab')
  await expectInsetFocus(mailboxes.filter({ hasText: 'Starred' }))
  await expect(page.getByTestId('mailbox-title')).toHaveText('Inbox')
  await captureFocus(page, page.getByTestId('mail-sidebar'), 'mailbox')
})

test('label focus stays inside the scrolling panel without changing the selected destination', async ({
  page
}) => {
  const labels = page.getByTestId('sidebar-label')
  await expect(labels).toHaveCount(12)
  const title = await page.getByTestId('mailbox-title').textContent()
  await labels.nth(1).focus()
  await expectInsetFocus(labels.nth(1))
  await expect(page.getByTestId('mailbox-title')).toHaveText(title ?? '')
  await captureFocus(page, page.getByTestId('sidebar-labels'), 'label')
})

test('settings navigation keeps the keyboard outline inside its scroll panel', async ({ page }) => {
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-appearance').click()
  await page.keyboard.press('Tab')
  await expectInsetFocus(page.getByTestId('settings-nav-triage'))
  await expect(page.getByTestId('settings-nav-appearance')).toHaveAttribute('aria-current', 'page')
  await captureFocus(page, page.getByRole('navigation', { name: 'Settings sections' }), 'settings')
})

test.describe('split navigation', () => {
  test.use({ seed: 'fixtures/seed-splits.json' })

  test('New split keeps its keyboard outline inside the scrolling column', async ({ page }) => {
    await page.getByTestId('split-rules-settings').click()
    const create = page.getByTestId('split-rule-new')
    await create.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expectInsetFocus(create)
    await captureFocus(page, create.locator('..'), 'new-split')
  })
})
