import { IPC_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

// T39 wiring under the harness, where no updater may exist: seeded builds
// construct nothing and make zero feed requests, so update:getState answers
// idle, `Restart to update` explains itself instead of restarting, and the
// ready broadcast surfaces the one quiet toast. Real update journeys are
// manual T40 evidence — they cannot run under the e2e harness.

test.use({ seed: 'fixtures/seed-inbox.json' })

test('a seeded build has no updater: idle state, refused restart, quiet ready toast', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  expect(await page.evaluate(() => window.attn.update.getState())).toEqual({
    phase: 'idle',
    readyVersion: null
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
