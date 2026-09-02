import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function chooseTheme(page: import('@playwright/test').Page, theme: string): Promise<void> {
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('theme-picker').selectOption(theme)
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    theme === 'system' ? /dispatch-(?:dark|light)/ : theme
  )
  await page.keyboard.press('Escape')
}

test('System follows the OS while a named palette persists across relaunch', async ({ boot, page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await chooseTheme(page, 'system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'light')

  await chooseTheme(page, 'midnight')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')

  const relaunched = await boot.relaunch()
  await expect(relaunched.page.getByTestId('thread-row')).toHaveCount(8)
  await expect.poll(() => relaunched.page.evaluate(() => window.attn.settings.initialTheme)).toBe('midnight')
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-theme-appearance', 'dark')
})

test('light mail uses sender colors and dark mail offers the original rendering', async ({
  page
}, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await chooseTheme(page, 'dispatch-light')
  const directory = join(__dirname, '.artifacts')
  mkdirSync(directory, { recursive: true })
  const inboxPath = join(directory, 'inbox-light.png')
  await page.screenshot({ path: inboxPath })
  await testInfo.attach('Light inbox', { path: inboxPath, contentType: 'image/png' })

  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-appearance', 'light')
  await expect(page.getByTestId('mail-original-toggle')).toHaveCount(0)
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('body')).toHaveCSS(
    'color',
    'rgb(32, 33, 36)'
  )

  await page.keyboard.press('Escape')
  await chooseTheme(page, 'dispatch-dark')
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('mail-original-toggle')).toHaveText('View original')
  await page.getByTestId('mail-original-toggle').click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('mail-original-toggle')).toHaveText('Use dark view')

  await page.keyboard.press('Escape')
  await chooseTheme(page, 'dispatch-light')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()
  await expect(page.getByTestId('html-body-frame')).toBeVisible()
  const readingPath = join(directory, 'reading-light.png')
  await page.screenshot({ path: readingPath })
  await testInfo.attach('Light reading', { path: readingPath, contentType: 'image/png' })
})
