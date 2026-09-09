import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'
import {
  emitSeam,
  expectResponseHeld,
  flushRendererIpc,
  holdNextResponse,
  type LifetimeSweepRequest,
  oldThread,
  runSweep
} from './seams'

// T32 (F15): the full-window settings surface, its palette commands, the
// accounts reorder, the notification pause, and the Mod+/ cheat sheet — all
// against seeded real SQLite stores, no Gmail.

const artifactDirectory = join(__dirname, '.artifacts')

function row(page: Page, subject: string) {
  return page.getByTestId('thread-row').filter({ hasText: subject })
}

test.describe('settings surface', () => {
  test.use({ seed: 'fixtures/seed-inbox.json' })

  test('opens by keyboard, account menu, and palette; Esc and Back restore the prior view exactly', async ({
    page
  }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('j')
    await expect(row(page, 'Your receipt')).toHaveAttribute('data-selected', 'true')

    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByTestId('settings-view')
    await expect(settings).toBeVisible()
    // The prior list stays mounted and hidden; settings hides the mail sidebar.
    await expect(page.getByTestId('mail-sidebar')).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toBeHidden()
    await expect(settings.getByTestId('settings-account-row')).toHaveCount(1)
    await expect(settings.getByTestId('settings-account-row')).toContainText('seed@attn.test')
    const accountScope = settings.getByTestId('settings-account-scope')
    const allAccountsScope = settings.getByTestId('settings-all-accounts-scope')
    await expect(accountScope).toContainText('This account')
    await expect(accountScope).toContainText('seed@attn.test')
    await expect(accountScope.getByTestId('settings-sync')).toBeVisible()
    await expect(accountScope.getByTestId('settings-compose')).toBeVisible()
    await expect(accountScope.getByTestId('settings-split-rules')).toHaveCount(0)
    await expect(allAccountsScope).toContainText('All accounts')
    await expect(allAccountsScope).toContainText('every signed-in account and mailbox')
    await expect(allAccountsScope.getByTestId('settings-triage')).toBeVisible()
    await expect(allAccountsScope.getByTestId('settings-security')).toBeVisible()
    await expect(settings.getByTestId('settings-sync-limit-mode')).toContainText(
      'Recommended — 400,000 email threads'
    )
    await expect(settings.getByTestId('settings-security')).toContainText('Security')
    await expect(settings.getByTestId('settings-remote-images-description')).toContainText(
      'every mailbox and signed-in account'
    )

    // Settings remain readable and every control fits its row at the default
    // app size. The AI rules field is deliberately fixed at ten lines.
    const layout = await settings.evaluate((root) => {
      const syncDescription = root.querySelector<HTMLElement>('[data-testid="settings-sync-description"]')
      const rules = root.querySelector<HTMLTextAreaElement>('[data-testid="settings-ai-voice-rules"]')
      const style = syncDescription ? getComputedStyle(syncDescription) : null
      const headings = [...root.querySelectorAll<HTMLElement>('h2, h3')]
      return {
        noHorizontalOverflow: root.scrollWidth <= root.clientWidth,
        descriptionFontSize: style?.fontSize,
        headingsUseNormalCase: headings.every(
          (heading) => getComputedStyle(heading).textTransform === 'none'
        ),
        rulesResize: rules ? getComputedStyle(rules).resize : null,
        rulesRows: rules?.rows
      }
    })
    expect(layout).toEqual({
      noHorizontalOverflow: true,
      descriptionFontSize: '13px',
      headingsUseNormalCase: true,
      rulesResize: 'none',
      rulesRows: 10
    })

    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'settings.png')
    await page.screenshot({ path })
    await testInfo.attach('settings', { path, contentType: 'image/png' })

    await allAccountsScope.evaluate((section) => section.scrollIntoView({ block: 'start' }))
    const scopesPath = join(artifactDirectory, 'settings-scopes.png')
    await page.screenshot({ path: scopesPath })
    await testInfo.attach('settings scopes', { path: scopesPath, contentType: 'image/png' })

    await settings
      .getByTestId('settings-ai')
      .evaluate((section) => section.scrollIntoView({ block: 'start' }))
    const aiPath = join(artifactDirectory, 'settings-ai.png')
    await page.screenshot({ path: aiPath })
    await testInfo.attach('settings-ai', { path: aiPath, contentType: 'image/png' })

    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(row(page, 'Your receipt')).toHaveAttribute('data-selected', 'true')

    // From the reader, Back restores the same conversation.
    await row(page, 'Lunch next week').click()
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('account-settings').click()
    await expect(settings).toBeVisible()
    await expect(page.getByTestId('conversation-view')).toBeHidden()
    await page.getByTestId('settings-back').click()
    await expect(settings).toHaveCount(0)
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')
    await page.keyboard.press('Escape')

    await runPaletteCommand(page, 'Open settings')
    await expect(settings).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
  })

  test('changes the undo-send delay through the real bridge and persists it across relaunch', async ({
    boot,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('ControlOrMeta+,')
    await page.getByTestId('settings-undo-send-delay').selectOption('20')
    await page.keyboard.press('Escape')

    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.addRecipient('undo@example.com')
    await composer.subject.fill('Undo window uses the configured delay')
    await composer.typeBody('The countdown must reflect the settings choice.')
    await composer.triggerSend()

    const toast = page.getByTestId('toast')
    await expect(toast).toHaveText('Sent — Undo (Z)')
    const durationMs = Number(await toast.getAttribute('data-toast-duration-ms'))
    expect(durationMs).toBeGreaterThan(15_000)
    expect(durationMs).toBeLessThanOrEqual(20_000)
    await page.keyboard.press('z')
    await expect(composer.root).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Shift+D')
    await expect(composer.root).toHaveCount(0)

    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-undo-send-delay')).toHaveValue('20')
  })

  test('auto-advance previous and back-to-list change where triage lands, and persist', async ({
    boot,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await runPaletteCommand(page, 'Set auto-advance')
    const settings = page.getByTestId('settings-view')
    await expect(settings).toBeVisible()
    // The palette deep-link lands focus on the auto-advance control.
    await expect(page.getByTestId('settings-auto-advance')).toBeFocused()
    await page.getByTestId('settings-auto-advance').selectOption('previous')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    // Archive the second row: the selection advances up, not down.
    await page.keyboard.press('j')
    await expect(row(page, 'Your receipt')).toHaveAttribute('data-selected', 'true')
    await page.keyboard.press('e')
    await expect(row(page, 'Q3 roadmap review')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('toast')).toHaveText('Marked done')

    // 'Back to list' closes the reader after triage instead of advancing.
    await page.keyboard.press('ControlOrMeta+,')
    await page.getByTestId('settings-auto-advance').selectOption('list')
    await page.keyboard.press('Escape')
    await row(page, 'Lunch next week').click()
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await page.keyboard.press('e')
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toBeVisible()
    await expect(row(page, 'Lunch next week')).toHaveCount(0)

    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(6)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-auto-advance')).toHaveValue('list')
  })

  test('notification pause and the unread badge setting persist and work from the palette', async ({
    boot,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('ControlOrMeta+,')
    const unreadBadge = page.getByTestId('settings-unread-badge')
    await expect(unreadBadge).toBeChecked()
    await unreadBadge.uncheck()
    await expect(unreadBadge).not.toBeChecked()
    await expect(page.getByTestId('settings-pause-state')).toHaveText('Notifications are on')
    await page.getByTestId('settings-pause-tomorrow').click()
    await expect(page.getByTestId('settings-pause-state')).toContainText('Paused until')
    await page.keyboard.press('Escape')

    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-unread-badge')).not.toBeChecked()
    await expect(relaunched.getByTestId('settings-pause-state')).toContainText('Paused until')
    await relaunched.getByTestId('settings-pause-resume').click()
    await expect(relaunched.getByTestId('settings-pause-state')).toHaveText('Notifications are on')
    await runPaletteCommand(relaunched, 'Toggle unread app badge')
    await expect(relaunched.getByTestId('settings-unread-badge')).toBeChecked()
    await relaunched.keyboard.press('Escape')

    // The palette exposes the same pause without a tray icon (Linux has none).
    await runPaletteCommand(relaunched, 'Pause notifications for 1 hour')
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-pause-state')).toContainText('Paused until')
    await runPaletteCommand(relaunched, 'Resume notifications')
    await expect(relaunched.getByTestId('settings-pause-state')).toHaveText('Notifications are on')
  })

  test('cheat sheet renders from the command registry and needs no source edit to stay current', async ({
    page
  }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('ControlOrMeta+/')
    const sheet = page.getByTestId('cheat-sheet')
    await expect(sheet).toBeVisible()
    const centered = await sheet.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        x: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
        y: Math.abs(box.top + box.height / 2 - window.innerHeight / 2)
      }
    })
    expect(centered.x).toBeLessThanOrEqual(1)
    expect(centered.y).toBeLessThanOrEqual(1)
    // The G chords come straight from the registry, grouped by category.
    await expect(sheet.getByTestId('cheat-sheet-command').filter({ hasText: 'Go to Inbox' })).toContainText(
      'G I'
    )
    await expect(sheet.getByTestId('cheat-sheet-command').filter({ hasText: 'Go to Snoozed' })).toContainText(
      'G H'
    )
    await expect(sheet.getByTestId('cheat-sheet-group').filter({ hasText: 'Triage' })).toContainText(
      'Mark done'
    )

    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'cheat-sheet.png')
    await page.screenshot({ path })
    await testInfo.attach('cheat-sheet', { path, contentType: 'image/png' })

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // A command registered through the e2e seam appears without editing the
    // sheet — it renders from the registry, not a hardcoded table.
    await page.evaluate(() => {
      const seam = (
        window as Window & {
          attnTest?: { registerCommand: (id: string, title: string, shortcut?: string) => void }
        }
      ).attnTest
      seam?.registerCommand('sheet-probe', 'Reticulate splines', 'Mod+Shift+Y')
    })
    await page.keyboard.press('ControlOrMeta+/')
    await expect(
      sheet.getByTestId('cheat-sheet-command').filter({ hasText: 'Reticulate splines' })
    ).toBeVisible()
    await page.keyboard.press('Escape')

    // The account menu opens the same sheet.
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('account-cheat-sheet').click()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  })

  test('the open cheat sheet contains keyboard input: a covered composer cannot act', async ({ page }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.typeBody('Draft under the sheet')

    await page.keyboard.press('ControlOrMeta+/')
    const sheet = page.getByTestId('cheat-sheet')
    await expect(sheet).toBeVisible()
    // The sheet is modal (PR #101 review): the composer underneath must not
    // receive its send shortcut — no queued send, not even a send error.
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('composer-send-error')).toHaveCount(0)
    await composer.expectPending(0)

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(composer.root).toBeVisible()
    // Focus returned to the body: typing continues in the draft.
    await page.keyboard.type('!')
    await expect(composer.editor).toContainText('!')
  })

  test('the account menu withholds Settings while a draft is open', async ({ page }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('j')
    await page.keyboard.press('Enter')
    const composer = new ComposerPage(page)
    await composer.openReply()

    // Settings hides the content column while composer key handlers stay
    // live, so the entry honors the same guard as the other account actions
    // (PR #101 review).
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await expect(page.getByTestId('account-settings')).toBeDisabled()
    await page.keyboard.press('Escape')

    // Save-and-close the draft; the entry re-arms.
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await expect(page.getByTestId('account-settings')).toBeEnabled()
    await page.getByTestId('account-settings').click()
    await expect(page.getByTestId('settings-view')).toBeVisible()
  })
})

test.describe('account reorder', () => {
  test.use({ seed: 'fixtures/seed-three-accounts.json' })

  test('reorders the roster, drives Mod+digits and successor order, and survives relaunch', async ({
    boot,
    page
  }) => {
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
    await expect(row(page, 'Alpha roadmap')).toBeVisible()

    await page.keyboard.press('ControlOrMeta+,')
    const rows = page.getByTestId('settings-account-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-email', 'primary@attn.test')

    // Move the active account down one slot: order changes, activity does not.
    await rows.nth(0).getByTestId('settings-account-down').click()
    await expect(rows.nth(0)).toHaveAttribute('data-email', 'second@attn.test')
    await expect(rows.nth(1)).toHaveAttribute('data-email', 'primary@attn.test')
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')

    // Malformed and stale permutations reject outright (no partial applies).
    for (const stale of [
      ['primary@attn.test'],
      ['primary@attn.test', 'primary@attn.test', 'second@attn.test'],
      ['second@attn.test', 'primary@attn.test', 'nobody@attn.test']
    ]) {
      expect(
        await page.evaluate(
          (ids) =>
            window.attn.auth.reorderAccounts(ids).then(
              () => 'accepted',
              () => 'rejected'
            ),
          stale
        )
      ).toBe('rejected')
    }
    await expect(rows.nth(0)).toHaveAttribute('data-email', 'second@attn.test')
    await page.keyboard.press('Escape')

    // Mod+1..9 follow the new order.
    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
    await expect(row(page, 'Beta launch')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+2')
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')

    // The order is durable, and the menu mirrors it.
    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('account-menu')).toContainText('primary@attn.test')
    await relaunched.getByTestId('account-menu').getByRole('button').first().click()
    const menuRows = relaunched.getByTestId('account-switch')
    await expect(menuRows).toHaveCount(3)
    await expect(menuRows.nth(0)).toHaveAttribute('data-email', 'second@attn.test')
    await expect(menuRows.nth(1)).toHaveAttribute('data-email', 'primary@attn.test')
    await expect(menuRows.nth(2)).toHaveAttribute('data-email', 'third@attn.test')
    await relaunched.keyboard.press('Escape')

    // Sign-out successor selection uses the same order: removing the active
    // account (position 1) activates the account now holding that position.
    await relaunched.keyboard.press('ControlOrMeta+,')
    await relaunched.getByTestId('settings-sign-out').click()
    await relaunched.getByTestId('remove-account-keep').click()
    await expect(relaunched.getByTestId('account-menu')).toContainText('third@attn.test')
    await expect(row(relaunched, 'Gamma planning')).toBeVisible()
  })

  test('a held reorder response cannot roll back an account switch it raced', async ({ app, page }) => {
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
    await page.keyboard.press('ControlOrMeta+,')
    const rows = page.getByTestId('settings-account-row')
    await expect(rows).toHaveCount(3)

    // Park the reorder's completed status snapshot in main, then switch away
    // before letting it land (PR #101 review).
    const release = await holdNextResponse(app, IPC_CHANNELS.accountsReorder)
    await rows.nth(0).getByTestId('settings-account-down').click()
    await expectResponseHeld(app)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-view')).toHaveCount(0)
    // The renderer still holds the pre-reorder order, so Mod+2 is second@.
    await page.keyboard.press('ControlOrMeta+2')
    await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
    await expect(row(page, 'Beta launch')).toBeVisible()

    // The stale snapshot may contribute only the roster ordering. Its landing
    // has no distinct visible effect (the switch response already carried the
    // new order), so give it a beat and assert the switch was not rolled
    // back — the buggy adoption reverted the chip immediately on release.
    await release()
    await flushRendererIpc(page)
    await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
    await expect(row(page, 'Beta launch')).toBeVisible()
    await page.getByTestId('account-menu').getByRole('button').first().click()
    const menuRows = page.getByTestId('account-switch')
    await expect(menuRows.nth(0)).toHaveAttribute('data-email', 'second@attn.test')
    await expect(menuRows.nth(1)).toHaveAttribute('data-email', 'primary@attn.test')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
  })
})

test.describe('historical sync limit', () => {
  test.use({ seed: 'fixtures/seed-two-accounts.json' })

  /** The script every sweep below runs against; the cap comes from the
      persisted preference the settings control wrote — no override here. */
  const sweepRequest: LifetimeSweepRequest = {
    threads: ['old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6'].map((id) =>
      oldThread(id, 'old-friend@example.com', 2019)
    ),
    pages: [
      { threadIds: ['old-1', 'old-2', 'old-3', 'old-4'], nextPageToken: 'page-2' },
      { pageToken: 'page-2', threadIds: ['old-5', 'old-6'] }
    ],
    threadsTotal: 8,
    messagesTotal: 8
  }

  async function setCustomLimit(page: Page, value: string): Promise<void> {
    await page.getByTestId('settings-sync-limit-mode').selectOption('custom')
    await page.getByTestId('settings-sync-limit-custom').fill(value)
    await page.getByTestId('settings-sync-limit-apply').click()
    await expectStoredLimit(page, Number(value))
  }

  /** The sweep seam and the settings write race through separate channels;
      poll the persisted value so every sweep reads the intended cap. */
  async function expectStoredLimit(page: Page, value: number | null): Promise<void> {
    await expect
      .poll(() =>
        page.evaluate(
          (accountId) =>
            window.attn.settings.getAccount(accountId).then((settings) => settings.lifetimeThreadCap),
          'primary@attn.test'
        )
      )
      .toBe(value)
  }

  /** Live utility read: the seam broadcasts nothing, so the sidebar lags. */
  async function expectAllMailCount(page: Page, count: number): Promise<void> {
    await expect
      .poll(() => page.evaluate(() => window.attn.mail.getMailboxCounts().then((counts) => counts.allMail)))
      .toBe(count)
  }

  test('caps, resumes from its saved page, and goes unlimited through the real bridge', async ({
    app,
    boot,
    page
  }, testInfo) => {
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
    await expect(page.getByTestId('thread-row')).toHaveCount(2)

    // The palette deep-link lands on the control; a small custom cap applies.
    await runPaletteCommand(page, 'Set historical sync limit')
    await expect(page.getByTestId('settings-sync-limit-mode')).toBeFocused()
    await expect(page.getByTestId('settings-sync-limit-mode')).toHaveValue('default')
    await setCustomLimit(page, '4')

    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'settings-sync.png')
    await page.screenshot({ path })
    await testInfo.attach('settings-sync', { path, contentType: 'image/png' })
    await page.keyboard.press('Escape')

    // The store holds 2 threads; the production sweep stops at 4.
    // Seeded profiles mark the sweep done; model an account mid-walk once.
    const capped = await runSweep(app, { ...sweepRequest, resetCursor: 'lifetime' })
    expect(capped.error).toBeUndefined()
    expect(capped.cursor).toBe('capped:lifetime')
    expect(capped.pageTokens).toEqual([undefined])
    await expectAllMailCount(page, 4)

    // Capped coverage is reported as a limit, not as still-syncing.
    await page.keyboard.press('/')
    await page.getByTestId('search-input').fill('correspondence')
    await expect(page.getByTestId('search-coverage')).toContainText(
      'Older headers are outside the local sync limit'
    )
    await page.keyboard.press('Escape')

    // Raising the reached limit resumes the same listing and preserves the
    // partial page's start count when it caps again mid-walk.
    await page.keyboard.press('ControlOrMeta+,')
    await setCustomLimit(page, '6')
    await page.keyboard.press('Escape')
    const resumed = await runSweep(app, sweepRequest)
    expect(resumed.cursor).toBe('capped:lifetime:page-2')
    expect(resumed.pageTokens).toEqual([undefined, 'page-2'])
    await expectAllMailCount(page, 6)

    // A lower reached limit makes no lifetime Gmail requests and deletes
    // nothing already stored.
    await page.keyboard.press('ControlOrMeta+,')
    await setCustomLimit(page, '3')
    await page.keyboard.press('Escape')
    const lowered = await runSweep(app, sweepRequest)
    expect(lowered.cursor).toBe('capped:lifetime:page-2')
    expect(lowered.pageTokens).toEqual([])
    await expectAllMailCount(page, 6)

    // All mail asks for confirmation, then walks the saved page to the end.
    await page.keyboard.press('ControlOrMeta+,')
    await page.getByTestId('settings-sync-limit-mode').selectOption('all')
    await expect(page.getByTestId('settings-sync-limit-confirm')).toContainText('disk space')
    await page.getByTestId('settings-sync-limit-confirm-apply').click()
    await expect(page.getByTestId('settings-sync-limit-confirm')).toHaveCount(0)
    await expectStoredLimit(page, 0)
    await page.keyboard.press('Escape')
    const unlimited = await runSweep(app, sweepRequest)
    expect(unlimited.cursor).toBe('done')
    expect(unlimited.pageTokens).toEqual(['page-2'])
    await expectAllMailCount(page, 8)

    // The choice survives relaunch, an exhausted cursor stays done, and the
    // other account keeps its own (default) preference.
    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(2)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-sync-limit-mode')).toHaveValue('all')
    await relaunched.keyboard.press('Escape')
    const settled = await runSweep(boot.app, sweepRequest)
    expect(settled.cursor).toBe('done')
    expect(settled.pageTokens).toEqual([])

    await relaunched.keyboard.press('ControlOrMeta+2')
    await expect(relaunched.getByTestId('account-menu')).toContainText('second@attn.test')
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-sync-limit-mode')).toHaveValue('default')
  })
})

test.describe('"Sent with Attn" footer', () => {
  test.use({ seed: 'fixtures/seed-two-accounts.json' })

  function setSendAsSignature(app: ElectronApplication, signature: string): Promise<void> {
    return emitSeam(app, TEST_CHANNELS.setSendAsSignature, signature)
  }

  async function expectStoredFooter(page: Page, accountId: string, value: boolean): Promise<void> {
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.attn.settings.getAccount(id).then((settings) => settings.attnSignatureEnabled),
          accountId
        )
      )
      .toBe(value)
  }

  function footer(page: Page) {
    return page.getByTestId('composer-attn-signature')
  }

  test('rides new drafts for the enabled account only and never retains an untouched draft', async ({
    app,
    boot,
    page
  }) => {
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
    await setSendAsSignature(app, '<div>Best,</div><div>Chao</div>')
    // An absent preference is enabled: attribution is the default for every
    // newly added account.
    await expectStoredFooter(page, 'primary@attn.test', true)

    // The footer lands after the (collapsed) Gmail signature, visible and
    // secondary-styled; the caret stays in the writing area.
    const composer = new ComposerPage(page)
    await composer.openNew()
    await expect(composer.signature).toHaveCount(1)
    await composer.expectSignatureCollapsed()
    await expect(footer(page)).toHaveText('Sent with Attn:')
    await expect(footer(page).getByRole('link', { name: 'Attn:' })).toHaveAttribute(
      'href',
      'https://github.com/stephenw310/attn'
    )
    await expect(footer(page)).toBeVisible()

    // Untouched footer-and-signature drafts are discarded on close.
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.keyboard.press('g')
    await page.keyboard.press('d')
    await expect(page.getByTestId('view-title')).toHaveText('Drafts')
    await expect(page.getByTestId('draft-row')).toHaveCount(0)
    await page.keyboard.press('g')
    await page.keyboard.press('i')

    // The other account can independently opt out.
    await page.keyboard.press('ControlOrMeta+2')
    await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
    await page.evaluate(() =>
      window.attn.settings.setAccount('second@attn.test', 'attnSignatureEnabled', false)
    )
    await expectStoredFooter(page, 'second@attn.test', false)
    await composer.openNew()
    await expect(footer(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')

    // The preference survives relaunch and shows in settings.
    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(2)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-attn-signature')).toBeChecked()
  })

  test('footer rides the draft lifecycle: reopen, preference change, undo send, and removal', async ({
    app,
    page
  }, testInfo) => {
    await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
    await setSendAsSignature(app, '<div>Best,</div><div>Chao</div>')
    await page.evaluate(() =>
      window.attn.settings.setAccount('primary@attn.test', 'attnSignatureEnabled', true)
    )
    await expectStoredFooter(page, 'primary@attn.test', true)

    // Reply composer: footer present exactly once, before the quote.
    await row(page, 'Alpha roadmap review').click()
    let composer = new ComposerPage(page)
    await composer.openReply()
    await expect(footer(page)).toHaveCount(1)
    await expect(footer(page)).toBeVisible()

    mkdirSync(artifactDirectory, { recursive: true })
    const darkPath = join(artifactDirectory, 'composer-attn-signature.png')
    await page.screenshot({ path: darkPath })
    await testInfo.attach('composer-attn-signature', { path: darkPath, contentType: 'image/png' })
    await page.emulateMedia({ colorScheme: 'light' })
    const lightPath = join(artifactDirectory, 'composer-attn-signature-light.png')
    await page.screenshot({ path: lightPath })
    await testInfo.attach('composer-attn-signature-light', { path: lightPath, contentType: 'image/png' })
    await page.emulateMedia({ colorScheme: 'dark' })

    await composer.editor.click()
    await composer.typeBody('Reply that keeps its footer.')
    await composer.expectSaved()
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)

    // A preference change leaves the saved draft unchanged.
    await page.evaluate(() =>
      window.attn.settings.setAccount('primary@attn.test', 'attnSignatureEnabled', false)
    )
    await expectStoredFooter(page, 'primary@attn.test', false)
    await composer.openReply()
    await expect(footer(page)).toHaveCount(1)
    await expect(composer.editor).toContainText('Reply that keeps its footer.')

    // Undo send returns the intact composer; the queued body carried exactly
    // one footer line.
    await composer.triggerSend()
    await expect(composer.root).toHaveCount(0)
    const optimistic = page.locator('[data-testid="message-card"][data-pending="true"]')
    await expect(optimistic).toHaveCount(1)
    await expect
      .poll(async () => {
        const text = await optimistic
          .getByTestId('html-body-frame')
          .contentFrame()
          .locator('body')
          .innerText()
        return text.split('Sent with Attn').length - 1
      })
      .toBe(1)
    await page.keyboard.press('z')
    await expect(composer.root).toBeVisible()
    await expect(footer(page)).toHaveCount(1)

    // Deleting the footer is an ordinary edit: it survives save and reopen,
    // and nothing reinserts it — not even a fresh send. (The save-revision
    // counters are per composer mount, so the reopened mount gets a fresh
    // driver before its retrying save assertion.)
    composer = new ComposerPage(page)
    await composer.root.waitFor()
    // A hidden window omits selectionchange, so anchor the pointer caret at the
    // footer's start through beforeinput before keydown-driven deletion.
    const footerBox = await footer(page).boundingBox()
    if (!footerBox) throw new Error('footer bounds missing')
    const footerY = footerBox.y + footerBox.height / 2
    await page.mouse.click(footerBox.x + 1, footerY)
    await page.keyboard.insertText('x')
    await page.keyboard.press('Backspace')
    for (let index = 0; index < 'Sent with Attn:'.length; index += 1) {
      await page.keyboard.press('Delete')
    }
    await expect(composer.editor).not.toContainText('Sent with Attn')
    await expect(composer.editor).toContainText('Reply that keeps its footer.')
    await composer.expectSaved()
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await composer.openReply()
    await expect(composer.editor).toContainText('Reply that keeps its footer.')
    await expect(composer.editor).not.toContainText('Sent with Attn')
    await composer.triggerSend()
    await expect(composer.root).toHaveCount(0)
    await expect
      .poll(async () => {
        const text = await optimistic
          .getByTestId('html-body-frame')
          .contentFrame()
          .locator('body')
          .innerText()
        return text.includes('Sent with Attn')
      })
      .toBe(false)
  })
})
