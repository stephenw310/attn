import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

// T32 (F15): the full-window settings surface, its palette commands, the
// accounts reorder, the notification pause, and the Mod+/ cheat sheet — all
// against seeded real SQLite stores, no Gmail.

const artifactDirectory = join(__dirname, '.artifacts')

function row(page: Page, subject: string) {
  return page.getByTestId('thread-row').filter({ hasText: subject })
}

async function openPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
  await page.getByTestId('command-palette-input').fill(query)
}

async function runPaletteCommand(page: Page, query: string): Promise<void> {
  await openPalette(page, query)
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
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
    // The prior list stays mounted and hidden; the sidebar stays visible.
    await expect(page.getByTestId('mail-sidebar')).toBeVisible()
    await expect(page.getByTestId('thread-list')).toBeHidden()
    await expect(settings.getByTestId('settings-account-row')).toHaveCount(1)
    await expect(settings.getByTestId('settings-account-row')).toContainText('seed@attn.test')

    mkdirSync(artifactDirectory, { recursive: true })
    const path = join(artifactDirectory, 'settings.png')
    await page.screenshot({ path })
    await testInfo.attach('settings', { path, contentType: 'image/png' })

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
    await expect(page.getByTestId('toast')).toHaveText('Archived')

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

  test('notification pause is settable from settings and palette and persists across relaunch', async ({
    boot,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByTestId('settings-pause-state')).toHaveText('Notifications are on')
    await page.getByTestId('settings-pause-tomorrow').click()
    await expect(page.getByTestId('settings-pause-state')).toContainText('Paused until')
    await page.keyboard.press('Escape')

    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-pause-state')).toContainText('Paused until')
    await relaunched.getByTestId('settings-pause-resume').click()
    await expect(relaunched.getByTestId('settings-pause-state')).toHaveText('Notifications are on')
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
})

test.describe('historical sync limit', () => {
  test.use({ seed: 'fixtures/seed-two-accounts.json' })

  interface SweepResult {
    cursor: string | null
    error?: string
    formats: string[]
    pageTokens: Array<string | undefined>
  }

  function oldThread(id: string): GmailThread {
    return {
      id,
      messages: [
        {
          id: `message-${id}`,
          threadId: id,
          labelIds: ['SENT'],
          internalDate: String(Date.UTC(2019, 0, 2)),
          snippet: `A header-only note (${id})`,
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'Primary <primary@attn.test>' },
              { name: 'To', value: 'old-friend@example.com' },
              { name: 'Subject', value: `Old correspondence ${id}` },
              { name: 'Message-ID', value: `<${id}@attn.test>` }
            ]
          }
        }
      ]
    }
  }

  /** The production sweep against a scripted provider; the cap comes from the
      persisted preference the settings control wrote — no override here. */
  async function runSweep(app: ElectronApplication, resetCursor?: string): Promise<SweepResult> {
    const request = {
      ...(resetCursor ? { resetCursor } : {}),
      threads: ['old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6'].map(oldThread),
      pages: [
        { threadIds: ['old-1', 'old-2', 'old-3', 'old-4'], nextPageToken: 'page-2' },
        { pageToken: 'page-2', threadIds: ['old-5', 'old-6'] }
      ],
      threadsTotal: 8,
      messagesTotal: 8
    }
    return app.evaluate(
      ({ ipcMain }, { channel, input }) =>
        new Promise<SweepResult>((resolve) => ipcMain.emit(channel, {}, input, resolve)),
      { channel: TEST_CHANNELS.runLifetimeSweep, input: request }
    )
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
    const capped = await runSweep(app, 'lifetime')
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
    const resumed = await runSweep(app)
    expect(resumed.cursor).toBe('capped:lifetime:page-2')
    expect(resumed.pageTokens).toEqual([undefined, 'page-2'])
    await expectAllMailCount(page, 6)

    // A lower reached limit makes no lifetime Gmail requests and deletes
    // nothing already stored.
    await page.keyboard.press('ControlOrMeta+,')
    await setCustomLimit(page, '3')
    await page.keyboard.press('Escape')
    const lowered = await runSweep(app)
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
    const unlimited = await runSweep(app)
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
    const settled = await runSweep(boot.app)
    expect(settled.cursor).toBe('done')
    expect(settled.pageTokens).toEqual([])

    await relaunched.keyboard.press('ControlOrMeta+2')
    await expect(relaunched.getByTestId('account-menu')).toContainText('second@attn.test')
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-sync-limit-mode')).toHaveValue('default')
  })
})
