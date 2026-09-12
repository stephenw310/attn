import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { openPalette, runPaletteCommand } from './nav'
import { setSyncState } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

for (const appearance of ['Light', 'Dark']) {
  test(`Tide dialogs fit the minimum window and preserve keyboard access in ${appearance}`, async ({
    page,
    app
  }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    await runPaletteCommand(page, `Use ${appearance} theme`)
    const dir = join(__dirname, '.artifacts')
    mkdirSync(dir, { recursive: true })
    const capture = async (name: string, testId: string) => {
      const dialog = page.getByTestId(testId)
      await expect(dialog).toBeVisible()
      const bounds = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          noHorizontalOverflow: element.scrollWidth <= element.clientWidth
        }
      })
      expect(bounds).toEqual({ fits: true, noHorizontalOverflow: true })
      await page.mouse.move(0, 0)
      const path = join(dir, `tide-final-${name}-${appearance.toLowerCase()}.png`)
      await page.screenshot({ path })
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }

    for (const palette of ['Matcha', 'Mist', 'Linen', 'Dusk']) {
      await runPaletteCommand(page, `Use ${palette} color palette`)
      await openPalette(page, 'Go to')
      await capture(`palette-${palette.toLowerCase()}`, 'command-palette')
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+/')
      await expect(page.locator('[data-command-id="composer.send"]')).toHaveCount(1)
      await capture(`shortcuts-${palette.toLowerCase()}`, 'cheat-sheet')
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('cheat-sheet').getByRole('button', { name: 'Close Esc' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('cheat-sheet')).toHaveCount(0)
    }

    await runPaletteCommand(page, 'Use Matcha color palette')
    await openPalette(page, 'zzzznonexistent')
    await expect(page.getByTestId('command-palette-empty')).toBeVisible()
    await capture('palette-empty', 'command-palette')
    await page.keyboard.press('Escape')

    await page.getByTestId('thread-list').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('l')
    await capture('labels', 'label-picker')
    await page.getByTestId('label-search').fill('zzzznonexistent')
    await expect(page.getByTestId('label-picker')).toContainText('No matching labels')
    await capture('labels-empty', 'label-picker')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('label-picker')).toHaveCount(0)

    await page.keyboard.press('v')
    await capture('move', 'move-picker')
    await page.keyboard.press('Escape')
    await page.keyboard.press('h')
    await capture('snooze', 'snooze-picker')
    await page.getByTestId('snooze-input').fill('not a date')
    await expect(page.getByTestId('snooze-custom-confirm')).toBeDisabled()
    await expect(page.getByTestId('snooze-resolved')).toContainText('Enter a time')
    await page.getByTestId('snooze-resolved').scrollIntoViewIfNeeded()
    await capture('snooze-invalid', 'snooze-picker')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('snooze-picker')).toHaveCount(0)
    await expect(page.getByTestId('thread-row')).toHaveCount(8)

    await setSyncState(app, {
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 750,
      threadsTotal: 2000,
      reason: 'running'
    })
    await page.getByTestId('status-content').click()
    await capture('sync', 'status-details')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('status-content')).toBeFocused()
    await setSyncState(app, {
      phase: 'error',
      message: 'Gmail could not be reached. Cached mail is still available.'
    })
    await page.getByTestId('status-error-button').click()
    await capture('sync-error', 'status-error-details')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('status-error-button')).toBeFocused()
    await setSyncState(app, { phase: 'idle' })

    await app.evaluate(
      ({ ipcMain }, channel) => ipcMain.emit(channel, {}, 20),
      TEST_CHANNELS.setUndoSendDelay
    )
    const composer = new ComposerPage(page)
    await page.getByRole('button', { name: 'Write', exact: true }).click()
    await expect(composer.root).toBeVisible()
    await composer.addRecipient('preview@example.com')
    await composer.subject.fill('Countdown preview')
    await composer.typeBody('This message will be undone locally.')
    await composer.triggerSend()
    await expect(page.getByTestId('toast-undo')).toBeVisible()
    await expect(page.getByTestId('toast').locator(':scope > div')).toHaveCSS('opacity', '1')
    await capture('undo', 'toast')
    await page.getByTestId('toast-undo').click()
    await expect(composer.root).toBeVisible()
    await composer.expectPending(0)
  })
}
