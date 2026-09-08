import { mkdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'
import { emitSeam } from './seams'

// T33 (SPEC F15): remote-content blocking enforced in main's request layer. The
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

function setMessageHtml(app: ElectronApplication, id: string, html: string): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.updateMessageBody, id, 'Lunch plans with a pixel.', html)
}

/**
 * Proving that nothing reaches the wire needs a window in which nothing may
 * arrive: there is no counter to poll toward and no product constant behind
 * it, so this states the window once, in one place, and fails at the first
 * unexpected hit rather than only when the window ends.
 */
const WIRE_QUIET_MS = 250

async function expectWireQuiet(probe: ProbeServer, page: Page, path?: string): Promise<void> {
  const hits = () => (path ? probe.count(path) : probe.hits.length)
  const deadline = Date.now() + WIRE_QUIET_MS
  do {
    expect(hits()).toBe(0)
    await page.waitForTimeout(25)
  } while (Date.now() < deadline)
  expect(hits()).toBe(0)
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
    await expectWireQuiet(probe, page)

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

test('a sender stylesheet cannot fetch another one', async ({ app, page }) => {
  const probe = await startProbeServer()
  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    // `@import` is the one way a kept <style> can reach off the machine, and an
    // imported sheet can carry `src: local(...)` faces that `font-src` never
    // sees. The frame's `style-src` is intersected with the renderer's own, and
    // neither admits a remote sheet.
    await setMessageHtml(
      app,
      'm-lunch',
      `<style>@import url("http://127.0.0.1:${probe.port}/imported.css");</style>` +
        `<div style="background:#0aa3d2">Lunch plans</div>`
    )
    await openLunch(page)
    const frame = page.getByTestId('html-body-frame')
    await expect(frame).toBeVisible()
    // The sheet has to have reached the frame for the quiet below to mean
    // anything: if sanitizing ever dropped it instead — the fail-closed path
    // taken when the sheet cannot be parsed — nothing would be fetched either,
    // and this would pass while proving nothing about the policy.
    const kept = await frame
      .contentFrame()
      .locator('body')
      .evaluate((body) => body.querySelectorAll('style').length)
    expect(kept).toBe(1)
    await expectWireQuiet(probe, page, '/imported.css')
    await closeReader(page)
  } finally {
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve())
    })
  }
})

test('a sender cannot ship a typeface of its own', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // A non-neutral canvas keeps the sender's <style> block, the one surface
  // where an @font-face of theirs would otherwise survive. Two things stop it:
  // the sanitizer drops the rule, so it never reaches the frame at all, and
  // `font-src 'self'` is the backstop if that ever regresses. The source is a
  // real face rather than a stub — an invalid one fails to load whatever the
  // policy says, which would make this assert nothing. Asserting the family is
  // absent rather than merely unloaded is what separates the two halves: a
  // blocked fetch would still leave it registered, in `error`.
  const face = readFileSync(
    require.resolve('@fontsource/alegreya/files/alegreya-latin-400-normal.woff2')
  ).toString('base64')
  await setMessageHtml(
    app,
    'm-lunch',
    `<style>@font-face{font-family:SenderFace;src:url(data:font/woff2;base64,${face})}</style>` +
      `<div style="background:#0aa3d2;font-family:SenderFace,serif">Lunch plans</div>`
  )
  await openLunch(page)
  const frame = page.getByTestId('html-body-frame')
  await expect(frame).toBeVisible()
  const seen = await frame
    .contentFrame()
    .locator('body')
    .evaluate(async (body) => {
      const fonts = body.ownerDocument.fonts
      await fonts.ready.catch(() => undefined)
      return {
        families: [...new Set([...fonts].map((registered) => registered.family))],
        css: body.ownerDocument.querySelector('style')?.textContent ?? ''
      }
    })
  expect(seen.families).not.toContain('SenderFace')
  expect(seen.css).not.toContain('font-face')
  await closeReader(page)
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
    // it is visible a blocked quote has already made its zero requests. Its
    // display copy uses an invisible placeholder rather than a broken-image
    // glyph; the saved and outgoing quote still keep the original source.
    expect(probe.hits.length).toBe(0)
    const blockedImage = page.getByTestId('composer-quote').contentFrame().locator('img')
    await expect(blockedImage).toHaveAttribute('data-remote-blocked', 'true')
    await expect(blockedImage).toHaveAttribute('src', /^data:image\/gif/)
    await expect(blockedImage).toBeHidden()
  } finally {
    await new Promise<void>((resolve) => {
      probe.server.close(() => resolve())
    })
  }
})

test('editable composer images obey blocking, per-sender exceptions, and the toggle', async ({
  app,
  page
}) => {
  // The editor renders in the TOP frame, which main's frame filter exempts —
  // an imported remote image previously fired an unfiltered tracking request
  // with blocking on (PR #101 review). The decision now happens before any
  // src is set, keyed like the quoted history: the draft's source message for
  // replies, the global toggle alone for drafts without one.
  const probe = await startProbeServer()
  // Distinct paths per pasted image: the reader frame fetches its own pixel,
  // so the editor assertions must count requests only the editor can make.
  const pasteImageSource = (composer: ComposerPage, alt: string, source: string): Promise<void> =>
    composer.editor.evaluate((editor, value) => {
      const clipboard = new DataTransfer()
      clipboard.setData('text/html', value)
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
      )
    }, `<img src="${source}" alt="${alt}" width="24" height="24">`)
  const pasteImage = (composer: ComposerPage, alt: string, path: string): Promise<void> =>
    pasteImageSource(composer, alt, `http://127.0.0.1:${probe.port}${path}`)
  try {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await setMessageHtml(
      app,
      'm-lunch',
      `<div>Lunch plans<img src="http://127.0.0.1:${probe.port}/pixel.png" alt="pixel" width="24" height="24"></div>`
    )
    await runPaletteCommand(page, 'Block remote images')
    await expectBlockedSetting(page, true)

    // Allow the sender from the reader, then paste a remote image into the
    // reply: the exception covers the editable image, so it loads.
    await openLunch(page)
    await expect(page.getByTestId('remote-images-banner')).toBeVisible()
    await page.getByTestId('remote-images-always-allow').click()
    await expect(page.getByTestId('remote-images-banner')).toHaveCount(0)
    const composer = new ComposerPage(page)
    await composer.openReply()
    await composer.editor.click()
    await pasteImage(composer, 'tracker', '/editor-reply.png')
    const replyImage = composer.editor.locator('img[alt="tracker"]')
    await expect(replyImage).toHaveAttribute('src', /editor-reply\.png/)
    await expect.poll(() => probe.count('/editor-reply.png')).toBeGreaterThan(0)

    // Removing the exception reaches the mounted image live: the src flips to
    // the placeholder and nothing further reaches the wire.
    await page.evaluate(() => window.attn.mail.removeRemoteImageOverride('amara@example.com'))
    await expect(replyImage).toHaveAttribute('data-remote-blocked', 'true')
    await expect(replyImage).toHaveAttribute('src', /^data:image\/gif/)
    probe.reset()
    await expectWireQuiet(probe, page, '/editor-reply.png')
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await closeReader(page)

    // A draft with no source message answers to the global toggle alone:
    // blocked while it is on, loading once it is turned off.
    await page.keyboard.press('c')
    const fresh = new ComposerPage(page)
    await expect(fresh.root).toBeVisible()
    await fresh.editor.click()
    await pasteImage(fresh, 'standalone', '/editor-new.png')
    const freshImage = fresh.editor.locator('img[alt="standalone"]')
    await expect(freshImage).toHaveAttribute('data-remote-blocked', 'true')
    expect(probe.count('/editor-new.png')).toBe(0)
    // URL policy uses Chromium's parser too: ASCII whitespace within a scheme
    // must not turn an HTTP source into an apparent local image.
    await pasteImageSource(fresh, 'wrapped-scheme', `ht\ntp://127.0.0.1:${probe.port}/editor-wrapped.png`)
    const wrappedImage = fresh.editor.locator('img[alt="wrapped-scheme"]')
    await expect(wrappedImage).toHaveAttribute('data-remote-blocked', 'true')
    expect(probe.count('/editor-wrapped.png')).toBe(0)
    // The palette is inert while composing; the bridge toggle broadcasts the
    // same policy change the palette command would.
    await page.evaluate(() => window.attn.settings.set('remoteImagesBlocked', false))
    await expectBlockedSetting(page, false)
    await expect(freshImage).toHaveAttribute('src', /editor-new\.png/)
    await expect.poll(() => probe.count('/editor-new.png')).toBeGreaterThan(0)
    await expect(wrappedImage).toHaveAttribute('src', /editor-wrapped\.png/)
    await expect.poll(() => probe.count('/editor-wrapped.png')).toBeGreaterThan(0)
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
