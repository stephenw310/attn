import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

// T33 (§9 #5): remote-content blocking enforced in main's request layer. The
// seeded message points its resources at a local HTTP server the test
// controls, so "zero requests" is a hard fact about the wire, not a rendering
// guess. Coverage spans request types beyond images (a stylesheet @import),
// SVG image references, policy changes reaching already-open messages, and
// the composer's quoted history (PR #101 review).

test.use({ seed: 'fixtures/seed-inbox.json' })

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

interface ProbeServer {
  server: Server
  port: number
  hits: string[]
  count: (path: string) => number
  reset: () => void
}

async function startProbeServer(): Promise<ProbeServer> {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if (request.url?.endsWith('.css')) {
      response.writeHead(200, { 'Content-Type': 'text/css' })
      response.end('body{color:#123456}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end(PIXEL_PNG)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: (server.address() as AddressInfo).port,
    hits,
    count: (path: string) => hits.filter((hit) => hit === path).length,
    reset: () => {
      hits.length = 0
    }
  }
}

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

async function expectBlockedSetting(page: Page, blocked: boolean): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.attn.settings.getAll().then((s) => s.remoteImagesBlocked)))
    .toBe(blocked)
}

test('blocking cancels every request type; overrides, live policy changes, and relaunch hold', async ({
  app,
  boot,
  page
}, testInfo) => {
  const probe = await startProbeServer()
  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    // An image plus a stylesheet @import: the display sanitizer keeps <style>,
    // so CSS-driven fetches are part of the attack surface, not just <img>.
    await setMessageHtml(
      app,
      'm-lunch',
      `<div>Lunch plans<img src="http://127.0.0.1:${probe.port}/pixel.png" alt="pixel" width="24" height="24"></div>` +
        `<style>@import url("http://127.0.0.1:${probe.port}/track.css");</style>`
    )

    // Decision #5 stands: without the toggle, images load exactly as today.
    // The stylesheet import must never reach the wire in ANY mode: mail
    // frames inherit the renderer CSP (style-src 'self' 'unsafe-inline'),
    // which denies non-image fetches outright; T33's request filter is the
    // second, policy-aware layer on top (PR #101 review).
    await openLunch(page)
    await expect.poll(() => probe.count('/pixel.png')).toBeGreaterThan(0)
    expect(probe.count('/track.css')).toBe(0)
    await expect(page.getByTestId('remote-images-banner')).toHaveCount(0)
    await closeReader(page)

    // Blocking on: opening the mail produces zero requests of any type, plus
    // the one-line banner.
    await runPaletteCommand(page, 'Block remote images')
    await expectBlockedSetting(page, true)
    probe.reset()
    await openLunch(page)
    const banner = page.getByTestId('remote-images-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Remote images blocked')
    expect(probe.hits.length).toBe(0)

    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    const path = join(__dirname, '.artifacts', 'remote-images-blocked.png')
    await page.screenshot({ path })
    await testInfo.attach('remote-images-blocked', { path, contentType: 'image/png' })

    // Load once admits exactly one render, and only that one. The CSS import
    // stays dead even then: the CSP layer does not have a Load once.
    await page.getByTestId('remote-images-load-once').click()
    await expect.poll(() => probe.count('/pixel.png')).toBe(1)
    expect(probe.count('/track.css')).toBe(0)
    await closeReader(page)
    await openLunch(page)
    await expect(banner).toBeVisible()
    expect(probe.count('/pixel.png')).toBe(1)

    // A policy change reaches the open message without reopening it: turning
    // blocking off clears the banner and the remounted frame fetches; turning
    // it back on restores the banner with no further requests.
    await runPaletteCommand(page, 'Load remote images')
    await expectBlockedSetting(page, false)
    await expect(banner).toHaveCount(0)
    await expect.poll(() => probe.count('/pixel.png')).toBeGreaterThanOrEqual(2)
    // The unblock remount can straggle (frame re-registration racing the
    // policy broadcast), so wait for the wire to go quiet before asserting
    // that re-blocking admits nothing — that assertion stays exact.
    await expect
      .poll(async () => {
        const before = probe.hits.length
        await page.waitForTimeout(250)
        return probe.hits.length - before
      })
      .toBe(0)
    probe.reset()
    await runPaletteCommand(page, 'Block remote images')
    await expectBlockedSetting(page, true)
    await expect(banner).toBeVisible()
    await page.waitForTimeout(250)
    expect(probe.hits.length).toBe(0)

    // Always load writes the per-sender override: the banner clears and the
    // remounted frame fetches again — exactly once, through the policy
    // broadcast, not a second local remount.
    await page.getByTestId('remote-images-always-allow').click()
    await expect(banner).toHaveCount(0)
    await expect.poll(() => probe.count('/pixel.png')).toBe(1)
    await closeReader(page)

    // The override survives relaunch: reopening loads without a banner.
    const { page: relaunched } = await boot.relaunch()
    await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
    probe.reset()
    await openLunch(relaunched)
    await expect.poll(() => probe.count('/pixel.png')).toBe(1)
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
    probe.reset()
    await openLunch(relaunched)
    await expect(relaunched.getByTestId('remote-images-banner')).toBeVisible()
    expect(probe.hits.length).toBe(0)
    await closeReader(relaunched)

    // Turning the toggle off restores default load, bannerless.
    await runPaletteCommand(relaunched, 'Load remote images')
    await expectBlockedSetting(relaunched, false)
    await openLunch(relaunched)
    await expect.poll(() => probe.count('/pixel.png')).toBeGreaterThan(0)
    await expect(relaunched.getByTestId('remote-images-banner')).toHaveCount(0)
  } finally {
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve())
    })
  }
})

test('a per-sender exception covers the composer quote, and its removal blocks it again', async ({
  app,
  page
}) => {
  const probe = await startProbeServer()
  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await setMessageHtml(
      app,
      'm-lunch',
      `<div>Lunch plans<img src="http://127.0.0.1:${probe.port}/pixel.png" alt="pixel" width="24" height="24"></div>`
    )
    await runPaletteCommand(page, 'Block remote images')
    await expectBlockedSetting(page, true)

    // Allow the sender from the reader, then open a reply: the quoted history
    // renders the same sender's mail, so the exception must cover it.
    await openLunch(page)
    await expect(page.getByTestId('remote-images-banner')).toBeVisible()
    await page.getByTestId('remote-images-always-allow').click()
    await expect(page.getByTestId('remote-images-banner')).toHaveCount(0)
    const composer = new ComposerPage(page)
    await composer.openReply()
    probe.reset()
    await page.getByTestId('composer-quote-toggle').click()
    await expect(page.getByTestId('composer-quote')).toBeVisible()
    await expect.poll(() => probe.count('/pixel.png')).toBe(1)

    // Remove the exception while the quote is open: the policy broadcast
    // re-registers the quote frame, and re-expanding it fetches nothing.
    await page.evaluate(() => window.attn.mail.removeRemoteImageOverride('amara@example.com'))
    probe.reset()
    await page.getByTestId('composer-quote-toggle').click()
    await expect(page.getByTestId('composer-quote')).toHaveCount(0)
    await page.getByTestId('composer-quote-toggle').click()
    await expect(page.getByTestId('composer-quote')).toBeVisible()
    // The frame mounts only after its registration answered, so by the time
    // it is visible a blocked quote has already made its zero requests.
    expect(probe.hits.length).toBe(0)
  } finally {
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve())
    })
  }
})

test('an SVG image reference is blocked with the banner controls present', async ({ app, page }) => {
  const probe = await startProbeServer()
  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    // The sanitizer preserves SVG <image href>; the banner must recognize it
    // or deliberately blocked content has no recovery path (PR #101 review).
    await setMessageHtml(
      app,
      'm-lunch',
      `<div>Lunch plans<svg width="24" height="24"><image href="http://127.0.0.1:${probe.port}/pixel.png" width="24" height="24"/></svg></div>`
    )
    await runPaletteCommand(page, 'Block remote images')
    await expectBlockedSetting(page, true)
    await openLunch(page)
    await expect(page.getByTestId('remote-images-banner')).toBeVisible()
    expect(probe.hits.length).toBe(0)
    await page.getByTestId('remote-images-load-once').click()
    await expect.poll(() => probe.count('/pixel.png')).toBe(1)
  } finally {
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve())
    })
  }
})
