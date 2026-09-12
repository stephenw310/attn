import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'
import { emitSeam } from './seams'

// T39 wiring under the harness, where no updater may exist: seeded builds
// construct nothing and make zero feed requests, so update:getState answers
// idle, `Restart to update` explains itself instead of restarting, and the
// ready broadcast surfaces the one quiet toast. Real update journeys are
// manual T40 evidence — they cannot run under the e2e harness.

test.use({ seed: 'fixtures/seed-inbox.json' })

const artifactDirectory = join(__dirname, '.artifacts')

test('a seeded build has no updater: idle state, refused restart, quiet ready toast', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  expect(await page.evaluate(() => window.attn.update.getState())).toEqual({
    phase: 'idle',
    readyVersion: null,
    lastCheck: null
  })

  // The palette command exists everywhere but never restarts without a
  // downloaded update.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Restart to update')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('toast')).toContainText('No update is ready yet')
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  // The ready broadcast (main → renderer) surfaces exactly one quiet toast.
  const sendReady = (): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(payload.channel, payload.state)
        }
      },
      {
        channel: IPC_CHANNELS.updateState,
        state: { phase: 'ready', readyVersion: '9.9.9' }
      }
    )
  await sendReady()
  await expect(page.getByTestId('toast')).toContainText('Update 9.9.9 ready')
  await sendReady()
  await expect(page.getByTestId('toast')).toContainText('Update 9.9.9 ready')
})

test('a ready update that predates the window is announced by the mount-time read', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  // A download can finish while no window exists; the broadcast then reaches
  // nobody. Stage a stored ready state and boot a fresh renderer against it:
  // the subscribe-then-read mount path must announce it without any
  // broadcast (PR #101 review).
  await emitSeam(app, TEST_CHANNELS.setUpdateState, { phase: 'ready', readyVersion: '9.9.10' })
  await page.reload()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('toast')).toContainText('Update 9.9.10 ready')
})

test('About shows the running version and build kind, and a ready update offers the restart', async ({
  app,
  page
}, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // The harness launches the unpackaged build, so the version it must show
  // is the repository's, not Electron's.
  const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string
  expect(version).toMatch(/^\d+\.\d+\.\d+/)

  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-about').click()
  const about = page.getByTestId('settings-view').getByTestId('settings-about')
  await expect(about).toBeVisible()
  await expect(about.getByTestId('settings-app-version')).toHaveText(`Attn v${version}`)
  // The harness runs the unpackaged build: no feed, no updater, and the
  // surface says so rather than offering a check that could never run.
  await expect(about.getByTestId('settings-app-build')).toHaveText('Development build')
  await expect(about.getByTestId('settings-update-status')).toContainText('Development builds never check')
  await expect(about.getByTestId('settings-update-check')).toHaveCount(0)
  await expect(about.getByTestId('settings-update-restart')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The palette command answers with the same status line.
  await runPaletteCommand(page, 'Check for updates')
  await expect(page.getByTestId('toast')).toContainText('Development builds never check')

  // A downloaded update surfaces its version and the restart button; with no
  // updater behind it the restart explains itself, exactly like the palette.
  await emitSeam(app, TEST_CHANNELS.setUpdateState, {
    phase: 'ready',
    readyVersion: '9.9.11',
    lastCheck: { at: Date.now(), outcome: 'available', version: '9.9.11' }
  })
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-about').click()
  await expect(about.getByTestId('settings-update-status')).toContainText('Version 9.9.11 is downloaded')
  await about.evaluate((section) => section.scrollIntoView({ block: 'end' }))
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'settings-about.png')
  await page.screenshot({ path })
  await testInfo.attach('settings-about', { path, contentType: 'image/png' })
  await about.getByTestId('settings-update-restart').click()
  await expect(page.getByTestId('toast')).toContainText('No update is ready yet')
  await expect(page.getByTestId('settings-view')).toBeVisible()
})
