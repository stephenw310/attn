import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

// T33 (§9 #5): remote-image blocking enforced in main's request layer. The
// seeded message points its image at a local HTTP server the test controls,
// so "zero requests" is a hard fact about the wire, not a rendering guess.

test.use({ seed: 'fixtures/seed-inbox.json' })

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function setMessageHtml(app: ElectronApplication, id: string, html: string): Promise<void> {
  const error = await app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<string | undefined>((resolve) =>
        ipcMain.emit(input.channel, {}, input.id, input.text, input.html, resolve)
      ),
    { channel: TEST_CHANNELS.updateMessageBody, id, text: 'Lunch plans with a pixel.', html }
  )
  if (error) throw new Error(error)
}

function lunchRow(page: Page) {
  return page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' })
}

async function openLunch(page: Page): Promise<void> {
  await lunchRow(page).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')
}

async function closeReader(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
}

async function runPaletteCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
  await page.getByTestId('command-palette-input').fill(query)
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

test('blocking cancels image requests; Load once and per-sender overrides admit them', async ({
  app,
  boot,
  page
}, testInfo) => {
  const hits: string[] = []
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end(PIXEL_PNG)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await setMessageHtml(
      app,
      'm-lunch',
      `<div>Lunch plans<img src="http://127.0.0.1:${port}/pixel.png" alt="pixel" width="24" height="24"></div>`
    )

    // Decision #5 stands: without the toggle, images load exactly as today.
    await openLunch(page)
    await expect.poll(() => hits.length).toBeGreaterThan(0)
    await expect(page.getByTestId('remote-images-banner')).toHaveCount(0)
    await closeReader(page)

    // Blocking on: opening the mail produces zero image requests, plus the
    // one-line banner.
    await runPaletteCommand(page, 'Block remote images')
    await expect
      .poll(() => page.evaluate(() => window.attn.settings.getAll().then((s) => s.remoteImagesBlocked)))
      .toBe(true)
    hits.length = 0
    await openLunch(page)
    const banner = page.getByTestId('remote-images-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Remote images blocked')
    expect(hits.length).toBe(0)

    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    const path = join(__dirname, '.artifacts', 'remote-images-blocked.png')
    await page.screenshot({ path })
    await testInfo.attach('remote-images-blocked', { path, contentType: 'image/png' })

    // Load once admits exactly one request and only this render.
    await page.getByTestId('remote-images-load-once').click()
    await expect.poll(() => hits.length).toBe(1)
    await closeReader(page)
    await openLunch(page)
    await expect(banner).toBeVisible()
    expect(hits.length).toBe(1)

    // Always load writes the per-sender override: the banner clears and the
    // remounted frame fetches again.
    await page.getByTestId('remote-images-always-allow').click()
    await expect(banner).toHaveCount(0)
    await expect.poll(() => hits.length).toBe(2)
    await closeReader(page)

    // The override survives relaunch: reopening loads without a banner.
    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
    hits.length = 0
    await openLunch(relaunched)
    await expect.poll(() => hits.length).toBe(1)
    await expect(relaunched.getByTestId('remote-images-banner')).toHaveCount(0)
    await closeReader(relaunched)

    // The settings section lists the override and removes it; blocking then
    // applies to that sender again.
    await relaunched.keyboard.press('ControlOrMeta+,')
    await expect(relaunched.getByTestId('settings-remote-images')).toBeChecked()
    const override = relaunched.getByTestId('settings-remote-image-override')
    await expect(override).toHaveAttribute('data-address', 'amara@example.com')
    await override.getByTestId('settings-remote-image-override-remove').click()
    await expect(override).toHaveCount(0)
    await relaunched.keyboard.press('Escape')
    hits.length = 0
    await openLunch(relaunched)
    await expect(relaunched.getByTestId('remote-images-banner')).toBeVisible()
    expect(hits.length).toBe(0)
    await closeReader(relaunched)

    // Turning the toggle off restores default load, bannerless.
    await runPaletteCommand(relaunched, 'Load remote images')
    await expect
      .poll(() => relaunched.evaluate(() => window.attn.settings.getAll().then((s) => s.remoteImagesBlocked)))
      .toBe(false)
    await openLunch(relaunched)
    await expect.poll(() => hits.length).toBeGreaterThan(0)
    await expect(relaunched.getByTestId('remote-images-banner')).toHaveCount(0)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
})
