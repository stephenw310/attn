import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

// F18 account switching against a seeded two-account store: the whole surface
// (chip, list, sidebar labels, unread readout) swaps atomically, every switch
// surface works (menu, palette, Mod+digit), the choice survives relaunch, and
// nothing from the other account bleeds through.

test.use({ seed: 'fixtures/seed-two-accounts.json' })

const PRIMARY = 'primary@attn.test'
const SECOND = 'second@attn.test'

test('menu switch swaps the entire surface and survives relaunch', async ({ page, boot }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()
  await expect(page.getByTestId('queue-unread')).toHaveText('1')
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'receipts' })).toBeVisible()

  await page.getByTestId('account-menu').getByRole('button').first().click()
  const menuRows = page.getByTestId('account-switch')
  await expect(menuRows).toHaveCount(2)
  await expect(menuRows.first()).toHaveAttribute('data-active', 'true')
  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  await page.screenshot({ path: join(artifactDirectory, 'account-menu.png') })

  await menuRows.filter({ hasText: SECOND }).click()
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('queue-unread')).toHaveText('2')
  // Isolation: no row, label, or count from the primary account survives.
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'receipts' })).toHaveCount(0)
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'launches' })).toBeVisible()

  // The active account is durable across a full relaunch (persisted app-side).
  const { page: relaunched } = await boot.relaunch()
  await expect(relaunched.getByTestId('account-menu')).toContainText(SECOND)
  await expect(
    relaunched.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })
  ).toBeVisible()
  await expect(relaunched.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)
})

test('keyboard and palette switching cover the roster', async ({ page }) => {
  // Keyboard input is meaningful only once the mail surface is mounted.
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Mod+2 jumps by switcher order without opening any menu.
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta weekly digest' })).toBeVisible()

  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha invoice attached' })).toBeVisible()

  // Every switch target is a palette command (F5).
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-input').fill('switch to')
  await expect(
    page.getByTestId('command-palette-result').filter({ hasText: `Switch to: ${SECOND}` })
  ).toBeVisible()
  await page
    .getByTestId('command-palette-result')
    .filter({ hasText: `Switch to: ${SECOND}` })
    .click()
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
})

test('signing out the active account falls back to the survivor, then to onboarding', async ({ page }) => {
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByRole('button', { name: /^Sign out/ }).click()
  // The second account is now the whole app.
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)

  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByRole('button', { name: /^Sign out/ }).click()
  // Zero accounts → F1's signed-out screen.
  await expect(page.getByTestId('account-menu')).toHaveCount(0)
  await expect(page.getByTestId('login-screen')).toBeVisible()
})
