import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { expectResponseHeld, holdNextResponse } from './seams'

// F18 account switching against a seeded two-account store: the whole surface
// (chip, list, sidebar labels, unread readout) swaps atomically, every switch
// surface works (menu, palette, Mod+digit), the choice survives relaunch, and
// nothing from the other account bleeds through.

test.use({ seed: 'fixtures/seed-two-accounts.json' })

const PRIMARY = 'primary@attn.test'
const SECOND = 'second@attn.test'

interface AccountDataStats {
  rowTotal: number
  perTable: Record<string, number>
  ftsRows: number
  accountsRow: number
  spoolEntries: string[]
}

/** Per-table row counts + spool inventory for one account (A6 zero-trace proof). */
async function accountDataStats(app: ElectronApplication, accountId: string): Promise<AccountDataStats> {
  return app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<AccountDataStats>((resolve) => ipcMain.emit(input.channel, {}, input.accountId, resolve)),
    { channel: TEST_CHANNELS.accountDataStats, accountId }
  )
}

/** Models a native notification click: a thread target, or null for a summary. */
async function emitNotificationClick(
  app: ElectronApplication,
  threadId: string | null,
  accountId: string
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.threadId, input.accountId),
    { channel: TEST_CHANNELS.focusThread, threadId, accountId }
  )
}

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

  // The menu's switch, add, and remove rows are disabled while composing…
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('account-switch').filter({ hasText: SECOND })).toBeDisabled()
  await expect(page.getByTestId('account-add')).toBeDisabled()
  await expect(page.getByTestId('account-remove')).toBeDisabled()
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

test('a pending reply blocks an account switch until its draft owns the current account', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.threadId, input.delayMs), {
    channel: TEST_CHANNELS.delayConversation,
    threadId: 't-alpha-roadmap',
    delayMs: 1_500
  })

  // The reader may already be prefetched. Its shell confirms that `r` ran,
  // while the hidden composer confirms the delayed reply is still pending.
  await page.keyboard.press('r')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('composer')).toBeHidden()
  await page.keyboard.press('ControlOrMeta+2')

  await expect(page.getByTestId('toast')).toContainText('Save and close the draft before switching accounts')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)

  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await composer.expectFrom(PRIMARY)
  await page.keyboard.press('Escape')
  await expect(composer.root).toBeHidden()
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
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

test('the account menu shows a one-line status for every account', async ({ page }) => {
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Background accounts' health must be discoverable without switching (F18):
  // one line per account — phase word plus its unread count.
  await page.getByTestId('account-menu').getByRole('button').first().click()
  const statuses = page.getByTestId('account-status')
  await expect(statuses).toHaveCount(2)
  await expect(statuses.first()).toHaveText('Live · 1 unread')
  await expect(statuses.nth(1)).toHaveText('Live · 2 unread')
})

for (const holdSnapshot of [false, true]) {
  test(`an open account menu follows live health changes${holdSnapshot ? ' during a snapshot read' : ''}`, async ({
    app,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(2)
    const release = holdSnapshot ? await holdNextResponse(app, IPC_CHANNELS.accountsGetStatuses) : null
    const chip = page.getByTestId('account-menu').getByRole('button').first()
    await chip.click()
    await expect(page.getByTestId('account-status').first()).toContainText('Live')
    if (release) await expectResponseHeld(app)
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.emit(channel, {}, { phase: 'error', message: 'Temporary sync failure' })
    }, TEST_CHANNELS.setSyncState)
    await expect(chip).toHaveAttribute('data-attention', 'true')
    await expect(page.getByTestId('account-status').first()).toContainText('Error')
    if (release) {
      await release()
      await expect(page.getByTestId('account-status').first()).toContainText('Error')
    }
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.emit(channel, {}, { phase: 'idle' })
    }, TEST_CHANNELS.setSyncState)
    await expect(page.getByTestId('account-status').first()).toContainText('Live')
    await expect(chip).not.toHaveAttribute('data-attention', 'true')
  })
}

test('account rows render before delayed sidebar totals and ignore totals from the previous account', async ({
  app,
  page
}) => {
  const inboxCount = page
    .getByTestId('sidebar-mailbox')
    .filter({ hasText: /^Inbox/ })
    .getByTestId('sidebar-count')
  await expect(inboxCount).toHaveAttribute('data-count', '2')
  const release = await holdNextResponse(app, IPC_CHANNELS.mailGetMailboxCounts)
  await page.keyboard.press('ControlOrMeta+2')
  await expectResponseHeld(app)
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)
  await expect(inboxCount).toHaveCount(0)
  // Make the primary count distinguishable before releasing the old account's response.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()
  await page.keyboard.press('e')
  await expect(inboxCount).toHaveAttribute('data-count', '1')
  await release()
  await expect(inboxCount).toHaveAttribute('data-count', '1')
})

test('account removal blocks shortcuts and composer opens until the response settles', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(2)
  const release = await holdNextResponse(app, IPC_CHANNELS.accountsRemove)
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('account-remove')).toHaveText('Sign out')
  await page.getByTestId('account-remove').click()
  await expect(page.getByTestId('remove-account-dialog')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+2')
  await page.keyboard.press('c')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('remove-account-dialog')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveCount(0)

  await page.getByTestId('remove-account-keep').click()
  await expectResponseHeld(app)
  expect((await page.evaluate(() => window.attn.auth.getStatus())).activeAccountId).toBe(SECOND)
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('c')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await release()
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('composer')).toHaveCount(0)
  expect(await page.evaluate(() => window.attn.draft.list())).toEqual([])
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.expectFrom(SECOND)
})

for (const { choice, lastAccount } of [
  { choice: 'keep', lastAccount: false },
  { choice: 'delete', lastAccount: false },
  { choice: 'delete', lastAccount: true }
] as const) {
  test(`failed ${choice} removal${lastAccount ? ' of the last account' : ''} keeps its warning across recovery and blocks composing until status settles`, async ({
    app,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(2)
    if (lastAccount) {
      const remaining = await page.evaluate((id) => window.attn.auth.removeAccount(id, false), SECOND)
      expect(remaining.activeAccountId).toBe(PRIMARY)
      expect(remaining.accounts).toHaveLength(1)
    }
    await app.evaluate(({ ipcMain }, channels) => {
      type Handler = Parameters<typeof ipcMain.handle>[1]
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const remove = handlers.get(channels.accountsRemove)
      const save = handlers.get(channels.draftSave)
      if (!remove || !save) throw new Error('Missing account/draft handlers')
      const activity = { draftSaves: 0 }
      Object.assign(globalThis, { removalActivity: activity })
      ipcMain.removeHandler(channels.draftSave)
      ipcMain.handle(channels.draftSave, (...args) => {
        activity.draftSaves++
        return save(...args)
      })
      ipcMain.removeHandler(channels.accountsRemove)
      ipcMain.handle(channels.accountsRemove, async (...args) => {
        // Retire the account but retain its local rows, as a failed spool purge does.
        await remove(args[0], args[1], false)
        throw new Error('Simulated failure after account retirement')
      })
    }, IPC_CHANNELS)
    // Park the status read the failed removal triggers, so the warning has to
    // stand on its own while the roster is still unknown to the renderer.
    const release = await holdNextResponse(app, IPC_CHANNELS.authGetStatus)
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('account-remove').click()
    await page.getByTestId(`remove-account-${choice}`).click()
    await expectResponseHeld(app)
    const warning = page.getByTestId('account-removal-error')
    await expect(warning).toContainText(
      choice === 'delete' ? 'Could not delete all local data' : 'Could not remove the account'
    )
    await expect(warning).toContainText(PRIMARY)
    // Let the rejection's React update commit before exercising the shortcut.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
    await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('c')
    // Wait through the draft IPC queue before asserting that composing stayed blocked.
    await page.evaluate(() => window.attn.draft.list())
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { removalActivity: { draftSaves: number } }).removalActivity.draftSaves
      )
    ).toBe(0)
    await expect(page.getByTestId('composer')).toHaveCount(0)
    await release()
    if (lastAccount) {
      await expect(page.getByTestId('login-screen')).toBeVisible()
      await expect(warning).toContainText('Could not delete all local data')
      await page.getByTestId('account-removal-error-dismiss').click()
      await expect(warning).toHaveCount(0)
      return
    }
    await expect(page.getByTestId('account-menu')).toContainText(SECOND)
    await expect(warning).toBeVisible()
    if (choice === 'delete') {
      expect((await accountDataStats(app, PRIMARY)).rowTotal).toBeGreaterThan(0)
      const directory = join(__dirname, '.artifacts')
      mkdirSync(directory, { recursive: true })
      await page.screenshot({ path: join(directory, 'account-removal-error.png') })
    }
    await page.getByTestId('account-removal-error-dismiss').click()
    await expect(warning).toHaveCount(0)
    expect(await page.evaluate(() => window.attn.draft.list())).toEqual([])
    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.expectFrom(SECOND)
    await composer.editor.fill('Text typed after account recovery')
    await composer.expectSaved()
    await expect(composer.editor).toContainText('Text typed after account recovery')
  })
}

test('a switch restores each account’s last view and selection', async ({ page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()
  const row = (subject: string): ReturnType<typeof page.getByTestId> =>
    page.getByTestId('thread-row').filter({ hasText: subject })

  // Move the primary account's selection off the default row.
  await page.keyboard.press('j')
  await expect(row('Alpha invoice attached')).toHaveAttribute('data-selected', 'true')

  // First visit to the second account lands on its defaults…
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(row('Beta launch checklist')).toHaveAttribute('data-selected', 'true')
  // …then it makes its own selection.
  await page.keyboard.press('j')
  await expect(row('Beta weekly digest')).toHaveAttribute('data-selected', 'true')

  // Returning to the primary account restores its selection (F18).
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(row('Alpha invoice attached')).toHaveAttribute('data-selected', 'true')

  // The view kind survives the round trip too: leave the primary account on a
  // label view, bounce through the second account, and land back on it.
  await page.getByTestId('sidebar-label').filter({ hasText: 'receipts' }).click()
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'receipts' })).toHaveAttribute(
    'data-active',
    'true'
  )
  await page.keyboard.press('ControlOrMeta+2')
  await expect(row('Beta weekly digest')).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'receipts' })).toHaveAttribute(
    'data-active',
    'true'
  )
})

test('a notification click for an inactive account switches to it and opens the thread', async ({
  app,
  page,
  mainLog
}) => {
  // The badge sums every account's unread from boot: 1 on primary + 2 on
  // second (F12/F18). The OS badge itself is invisible headless; the
  // change-log line is the assertable surface.
  await expect.poll(mainLog).toContain('[badge] unread 3')

  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  await emitNotificationClick(app, 't-beta-launch', SECOND)

  // The click switches the whole surface to the owning account, then opens
  // its conversation — with zero rows from the previous account surviving.
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Beta launch checklist')
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)
})

test('a summary notification click lands on the owning account inbox', async ({ app, page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  await emitNotificationClick(app, null, SECOND)

  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  // A summary names no single thread, so no conversation opens (F12).
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})

test('an open composer holds a notification switch until the draft closes', async ({ app, page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Keystrokes a notification click must not drop')
  await composer.expectSaved()

  await emitNotificationClick(app, 't-beta-launch', SECOND)

  // The guarded switch refuses while composing (F18): same toast, same account.
  await expect(page.getByTestId('toast')).toContainText('Save and close the draft')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(composer.root).toBeVisible()

  // Esc saves and closes; the notification target is still pending (60s TTL),
  // so completing the switch by hand finishes the click's journey.
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  // The pending target has a 60s TTL; under a loaded runner the second
  // account's rows can take past the default expectation window to land, so
  // the journey's end gets headroom without weakening what it asserts.
  await expect(page.getByTestId('conversation-subject')).toHaveText('Beta launch checklist', {
    timeout: 15_000
  })
})

test('a notification click survives a pull that dies during the account remount', async ({ app, page }) => {
  // The T32 regression, made deterministic: hold the switch response after
  // main has already flipped the active account, and while it is held issue a
  // focus pull whose delivery is discarded — the exact shape of a pull
  // consumed by a torn-down subscription during composer close and account
  // remount. Resolving must not consume: the remounted tree's own pull still
  // has to find the target and open the conversation.
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Held-response notification click')
  await composer.expectSaved()

  await emitNotificationClick(app, 't-beta-launch', SECOND)
  await expect(page.getByTestId('toast')).toContainText('Save and close the draft')
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  const release = await holdNextResponse(app, IPC_CHANNELS.accountsSetActive)
  await page.keyboard.press('ControlOrMeta+2')
  await expectResponseHeld(app)

  // The adversarial pull: main answers `focus` (its active account already
  // flipped), but nothing delivers or acknowledges the result.
  await app.evaluate(async ({ ipcMain }, channel) => {
    type Handler = (...args: unknown[]) => Promise<unknown>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    await handler({})
  }, IPC_CHANNELS.mailTakePendingFocus)

  await release()
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Beta launch checklist')
})

test('search, autocomplete, and pickers stay account-scoped after switches', async ({ page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Bounce across the roster so both surfaces are warm before probing (A7).
  for (const [digit, email, subject] of [
    ['2', SECOND, 'Beta launch checklist'],
    ['1', PRIMARY, 'Alpha roadmap review'],
    ['2', SECOND, 'Beta launch checklist'],
    ['1', PRIMARY, 'Alpha roadmap review']
  ] as const) {
    await page.keyboard.press(`ControlOrMeta+${digit}`)
    await expect(page.getByTestId('account-menu')).toContainText(email)
    await expect(page.getByTestId('thread-subject').filter({ hasText: subject })).toBeVisible()
  }

  // Local search never crosses accounts: the other inbox's content is silent.
  await page.keyboard.press('/')
  const searchInput = page.getByTestId('search-input')
  await searchInput.fill('Beta')
  await expect(page.getByTestId('thread-row')).toHaveCount(0)
  await searchInput.fill('Alpha')
  await expect(page.getByTestId('thread-row')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('search-input')).toHaveCount(0)

  // Contact autocomplete comes only from this account's mail (F10/F18).
  expect(await page.evaluate(() => window.attn.contacts.search('priya'))).toEqual([])
  const contacts = await page.evaluate(() => window.attn.contacts.search('maya'))
  expect(contacts.map((contact) => contact.email)).toEqual(['maya@example.com'])

  // Label and Move pickers list this account's catalog alone.
  await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('l')
  const labelPicker = page.getByTestId('label-picker')
  await expect(labelPicker).toBeVisible()
  await expect(labelPicker.getByTestId('label-option').filter({ hasText: 'receipts' })).toHaveCount(1)
  await expect(labelPicker.getByTestId('label-option').filter({ hasText: 'launches' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('v')
  const movePicker = page.getByTestId('move-picker')
  await expect(movePicker).toBeVisible()
  await expect(movePicker.getByTestId('move-option').filter({ hasText: 'receipts' })).toHaveCount(1)
  await expect(movePicker.getByTestId('move-option').filter({ hasText: 'launches' })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('auth pause on one account stays its own: banner, chip mark, and reconnect', async ({ app, page }) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Poison the primary account's next archive with a 401 (seeded auth seam).
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.threadId), {
    channel: TEST_CHANNELS.failNextActionAuth,
    threadId: 't-alpha-roadmap'
  })
  await page.keyboard.press('e')
  await expect(page.getByTestId('action-reconnect')).toContainText('1 paused · Reconnect Google')

  // The chip marks the roster while any account needs reauth (F18)…
  const chip = page.getByTestId('account-menu').getByRole('button').first()
  await expect(chip).toHaveAttribute('data-attention', 'true')
  // …and the menu names which one.
  await chip.click()
  await expect(page.getByTestId('account-status').first()).toContainText('Reconnect')
  await page.keyboard.press('Escape')

  // The pause belongs to the primary account alone: no banner on the second,
  // and its triage keeps flowing.
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('action-reconnect')).toHaveCount(0)
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(2)
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('account-menu').getByRole('button').first()).toHaveAttribute(
    'data-attention',
    'true'
  )

  // Reconnecting from the paused account resumes exactly its queue.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await page.getByTestId('action-reconnect').click()
  await expect(page.getByTestId('toast')).toHaveText('Google reconnected — 1 pending change is retrying.')
  await expect(page.getByTestId('action-reconnect')).toHaveCount(0)
  await expect(page.getByTestId('paused-count')).toHaveCount(0)
})

test('an undo-send window survives a switch with its toast hidden and Z inert elsewhere', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.seconds), {
    channel: TEST_CHANNELS.setUndoSendDelay,
    seconds: 30
  })
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('someone@example.com')
  await composer.subject.fill('Deadline survives the switch')
  await composer.typeBody('Body')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveText('Sent — Undo (Z)')

  // The toast belongs to the sending account's context: hidden after the
  // switch, while the durable deadline keeps counting (F18/F6).
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('toast').filter({ hasText: 'Undo' })).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(page.getByTestId('composer')).toHaveCount(0)

  // Back on the owner: still queued, and reopening restores the composer.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('outbox-count')).toContainText('1 in Outbox')
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  const queuedRow = page.getByTestId('outbox-row').first()
  await expect(queuedRow).toHaveAttribute('data-outbox-state', 'queued')
  await expect(queuedRow).toContainText('Deadline survives the switch')
  await queuedRow.click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(composer.editor).toContainText('Body')
})

test('a reply drafted on one account keeps its From and Drafts membership across switches', async ({
  page
}) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  const composer = new ComposerPage(page)
  await composer.openReply()
  // The From field renders the draft's owning account, bound at open (F6).
  await composer.expectFrom(PRIMARY)
  await composer.typeBody('Reply bound to the primary account')
  await composer.expectSaved()
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  // The second account's Drafts view must not list it (scoping, F18).
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await expect(page.getByTestId('mailbox-title')).toHaveText('Drafts')
  await expect(page.getByTestId('draft-row')).toHaveCount(0)

  // Back on the owner, the thread reopens into the same draft, same From.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('chip-draft').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await composer.root.waitFor()
  await composer.expectFrom(PRIMARY)
  await expect(composer.editor).toContainText('Reply bound to the primary account')
})

test.describe('three-account removal order', () => {
  test.use({ seed: 'fixtures/seed-three-accounts.json' })

  for (const choice of ['keep', 'delete'] as const) {
    test(`${choice} moves from the middle account to its successor, then wraps from the last`, async ({
      page,
      boot
    }) => {
      await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
      await page.keyboard.press('ControlOrMeta+2')
      await expect(page.getByTestId('account-menu')).toContainText(SECOND)
      await page.getByTestId('account-menu').getByRole('button').first().click()
      await page.getByTestId('account-remove').click()
      await page.getByTestId(`remove-account-${choice}`).click()
      await expect(page.getByTestId('account-menu')).toContainText('third@attn.test')
      await expect(page.getByTestId('thread-subject')).toHaveText('Gamma planning')

      const { page: relaunched } = await boot.relaunch()
      await expect(relaunched.getByTestId('account-menu')).toContainText('third@attn.test')
      await relaunched.getByTestId('account-menu').getByRole('button').first().click()
      await expect(relaunched.getByTestId('account-switch')).toHaveCount(2)
      await relaunched.getByTestId('account-remove').click()
      await relaunched.getByTestId(`remove-account-${choice}`).click()
      await expect(relaunched.getByTestId('account-menu')).toContainText(PRIMARY)
      await expect(relaunched.getByTestId('thread-subject')).toHaveText('Alpha roadmap')
    })
  }
})

test('removing the active account falls back to the survivor, then to onboarding', async ({ page }) => {
  const openRemoveDialog = async (): Promise<void> => {
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('account-remove').click()
    await expect(page.getByTestId('remove-account-dialog')).toBeVisible()
  }

  await openRemoveDialog()
  await page.getByTestId('remove-account-keep').click()
  // The second account is now the whole app.
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)

  // Cancel leaves everything alone before the real removal.
  await openRemoveDialog()
  await page.getByTestId('remove-account-cancel').click()
  await expect(page.getByTestId('remove-account-dialog')).toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)

  await openRemoveDialog()
  await page.getByTestId('remove-account-keep').click()
  // Zero accounts → F1's signed-out screen.
  await expect(page.getByTestId('account-menu')).toHaveCount(0)
  await expect(page.getByTestId('login-screen')).toBeVisible()
})

test('removing an account with Delete purges every local trace and survives relaunch', async ({
  app,
  boot,
  page
}) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha roadmap review' })).toBeVisible()

  // Give the doomed account a spooled attachment so file cleanup is provable.
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.paths), {
    channel: TEST_CHANNELS.setAttachmentPickerFiles,
    paths: [join(__dirname, 'fixtures', 't17-attachment.txt')]
  })
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.pickAttachments()
  await expect(composer.attachmentChips).toContainText('t17-attachment.txt')
  await composer.typeBody('Doomed draft')
  await composer.expectSaved()
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  const before = await accountDataStats(app, PRIMARY)
  expect(before.rowTotal).toBeGreaterThan(0)
  expect(before.accountsRow).toBe(1)
  expect(before.spoolEntries.length).toBeGreaterThan(0)

  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('account-remove').click()
  await page.getByTestId('remove-account-delete').click()

  // The surface falls to the survivor with nothing of the removed account.
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta launch checklist' })).toBeVisible()
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Alpha' })).toHaveCount(0)

  // Zero rows in any account-keyed table, zero FTS entries, zero spool files
  // (F18 acceptance criteria) — removal is the privacy boundary (D3).
  await expect
    .poll(async () => {
      const after = await accountDataStats(app, PRIMARY)
      return { ...after, perTable: undefined }
    })
    .toEqual({
      rowTotal: 0,
      perTable: undefined,
      ftsRows: 0,
      accountsRow: 0,
      spoolEntries: []
    })

  // Removal is durable: a relaunch boots only the survivor.
  const { page: relaunched } = await boot.relaunch()
  await expect(relaunched.getByTestId('account-menu')).toContainText(SECOND)
  await relaunched.getByTestId('account-menu').getByRole('button').first().click()
  await expect(relaunched.getByTestId('account-switch')).toHaveCount(1)
})

test('removing an account with Keep leaves dormant rows and stays removed across relaunch', async ({
  app,
  boot,
  page
}) => {
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByTestId('account-menu')).toContainText(SECOND)

  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('account-remove').click()
  await page.getByTestId('remove-account-keep').click()

  // Fallback to the survivor; nothing lists the removed account.
  await expect(page.getByTestId('account-menu')).toContainText(PRIMARY)
  await expect(page.getByTestId('thread-subject').filter({ hasText: 'Beta' })).toHaveCount(0)
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('account-switch')).toHaveCount(1)
  await page.keyboard.press('Escape')

  // The rows stay, dormant, so re-adding the address resumes from its stored
  // cursors instead of re-backfilling (D3 Keep; resume proven in runtime tests).
  const stats = await accountDataStats(app, SECOND)
  expect(stats.rowTotal).toBeGreaterThan(0)
  expect(stats.accountsRow).toBe(1)

  // Dormancy is durable: a relaunch must not resurrect the account.
  const relaunch = await boot.relaunch()
  await expect(relaunch.page.getByTestId('account-menu')).toContainText(PRIMARY)
  await relaunch.page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(relaunch.page.getByTestId('account-switch')).toHaveCount(1)
  const durable = await accountDataStats(relaunch.app, SECOND)
  expect(durable.rowTotal).toBeGreaterThan(0)
})
