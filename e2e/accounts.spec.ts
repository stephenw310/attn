import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
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

test('an open composer blocks account switching until the draft is saved closed', async ({ page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.typeBody('Draft that must survive an account switch')
  await composer.expectSaved()

  // The menu's switch, add, and sign-out rows are disabled while composing…
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('account-switch').filter({ hasText: SECOND })).toBeDisabled()
  await expect(page.getByTestId('account-add')).toBeDisabled()
  await expect(page.getByRole('button', { name: /^Sign out/ })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('account-switch')).toHaveCount(0)

  // …and the keyboard switcher is inert, so the draft keeps its surface.
  await page.keyboard.press('ControlOrMeta+2')
  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)

  // Esc saves and closes the draft (F6); only then does the switch proceed.
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)

  // Nothing was lost: back on the first account, the thread reopens straight
  // into the saved reply draft with the typed content intact.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('chip-draft').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await composer.root.waitFor()
  await expect(composer.editor).toContainText('Draft that must survive an account switch')
})

test('composer opens stay inert while an account switch is settling', async ({ app, page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Model the slow path: a switch can wait on a retiring session for seconds.
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.delayMs), {
    channel: TEST_CHANNELS.delaySetActiveAccount,
    delayMs: 1500
  })
  await page.keyboard.press('ControlOrMeta+2')

  // While the switch is in flight, every composer entry point is inert — a
  // composer opened now would be remounted away with its keystrokes (F18).
  await page.keyboard.press('c')
  await page.keyboard.press('r')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)

  // The switch settles normally, still with no composer, and composing then
  // works on the switched-to account.
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await page.keyboard.press('c')
  await expect(page.getByTestId('composer')).toBeVisible()
})

test('a queued send survives an Outbox click made while a switch is settling', async ({ app, page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Queue a send with a long undo window, then browse to Outbox.
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.seconds), {
    channel: TEST_CHANNELS.setUndoSendDelay,
    seconds: 30
  })
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('someone@example.com')
  await composer.subject.fill('Queued while switching accounts')
  await composer.typeBody('Body')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  const outboxRow = page.getByTestId('outbox-row').first()
  await expect(outboxRow).toHaveAttribute('data-outbox-state', 'queued')

  // Clicking the queued row mid-switch must be a no-op: undoSend would cancel
  // the scheduled send, and the gated composer could never show it again.
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.delayMs), {
    channel: TEST_CHANNELS.delaySetActiveAccount,
    delayMs: 1500
  })
  await page.keyboard.press('ControlOrMeta+2')
  // The queued row repaints its live countdown every frame, so Playwright's
  // stability gate cannot pass inside the switch window; force the click —
  // the app-side gate, not hit-testing, is what this regression exercises.
  await outboxRow.click({ force: true })
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)

  // Back on the first account, the send is still queued, untouched.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('outbox-count')).toContainText('1 in Outbox')
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  const survivingRow = page.getByTestId('outbox-row').first()
  await expect(survivingRow).toContainText('Queued while switching accounts')
  await expect(survivingRow).toHaveAttribute('data-outbox-state', 'queued')
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
