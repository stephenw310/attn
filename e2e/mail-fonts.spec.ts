import { readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { emitSeam } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

/**
 * A sender ships no typeface of its own. The sanitizer drops every `@font-face`
 * using the engine's own parser, and `font-src 'self'` stands behind that.
 *
 * These cases are here rather than in a unit test because the guard's whole
 * claim is that it agrees with Chromium about what an at-rule is, and only
 * Chromium settles that. Each one below was written against a hand-rolled scan
 * that read the sheet as text; every one of them got a face past it.
 */
const SHEETS: [name: string, css: string][] = [
  ['plain', '@font-face{font-family:F0;src:SRC}'],
  ['hex escape in the name', '@\\66 ont-face{font-family:F1;src:SRC}'],
  ['form feed after the escape', '@\\66\font-face{font-family:F2;src:SRC}'],
  ['carriage return after the escape', '@\\66\ront-face{font-family:F3;src:SRC}'],
  ['comment between keyword and block', '@font-face/**/{font-family:F4;src:SRC}'],
  ['nested in @media', '@media all{@font-face{font-family:F5;src:SRC}}'],
  ['nested in @supports', '@supports (color:red){@font-face{font-family:F6;src:SRC}}'],
  ['behind a url holding a quoted paren', 'p{x:url( ")")}@font-face{font-family:F7;src:SRC}'],
  ['behind a url holding an escaped paren', 'p{x:url(a\\)"b)}@font-face{font-family:F8;src:SRC}'],
  ['behind a bad string ended by a carriage return', 'p{c:"\r}@font-face{font-family:F9;src:SRC}'],
  ['behind an escaped CRLF inside a string', 'p{c:"\\\r\na"}@font-face{font-family:F10;src:SRC}'],
  ['behind an identifier that ends in url', 'p{x:blurl(a")"b)}@font-face{font-family:F11;src:SRC}'],
  ['behind an escaped url token', 'p{x:\\75rl(a"b)}@font-face{font-family:F12;src:SRC}'],
  ['a name escape above the Unicode range', '@\\FFFFFF{}@font-face{font-family:F13;src:SRC}']
]

/** Every family the sheets above try to declare. */
const FAMILIES = SHEETS.map((_, index) => `F${index}`)

function setBody(app: ElectronApplication, html: string): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.updateMessageBody, 'm-lunch', 'Lunch plans.', html)
}

async function framedFamilies(page: Page): Promise<string[]> {
  const frame = page.getByTestId('html-body-frame')
  await expect(frame).toBeVisible()
  return frame
    .contentFrame()
    .locator('body')
    .evaluate(async (body) => {
      const fonts = body.ownerDocument.fonts
      await fonts.ready.catch(() => undefined)
      return [...new Set([...fonts].map((face) => face.family))]
    })
}

test('no sheet a sender writes can declare a face', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // A real face: an invalid one fails to load whatever the policy says, which
  // would make every assertion below vacuous.
  const source = `url(data:font/woff2;base64,${readFileSync(
    require.resolve('@fontsource/alegreya/files/alegreya-latin-400-normal.woff2')
  ).toString('base64')})`
  // One <style> per case: a face found in a sheet rewrites that sheet, so
  // sharing one element would let a single catch mask the rest.
  const sheets = SHEETS.map(([, css]) => `<style>${css.replace('SRC', source)}</style>`).join('')
  // A non-neutral canvas is the surface that keeps a sender's <style> at all.
  await setBody(app, `${sheets}<div style="background:#0aa3d2">Lunch plans</div>`)
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')

  const families = await framedFamilies(page)
  // Naming the survivors beats a bare count: a failure says which form got in.
  expect(families.filter((family) => FAMILIES.includes(family))).toEqual([])
  await page.keyboard.press('Escape')
})

test('a sheet cannot smuggle a second one past the check for one', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // Serializing a parsed sheet turns `\3c` back into a literal `<`. DOMPurify
  // inspects text for that before the hook that rewrites it, so a rewrite made
  // afterwards would hand the frame a second stylesheet nothing had looked at.
  // There is no literal `<` in the input, which is what let it past the probe.
  const source = `url(data:font/woff2;base64,${readFileSync(
    require.resolve('@fontsource/alegreya/files/alegreya-latin-400-normal.woff2')
  ).toString('base64')})`
  await setBody(
    app,
    `<style>@font-face{font-family:Dropped;src:${source}}` +
      `p{content:"\\3c/style>\\3cstyle>@font-face{font-family:Smuggled;src:${source}}\\3c/style>"}</style>` +
      `<div style="background:#0aa3d2">Lunch plans</div>`
  )
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')

  const families = await framedFamilies(page)
  expect(families).not.toContain('Smuggled')
  expect(families).not.toContain('Dropped')
  const sheets = await page
    .getByTestId('html-body-frame')
    .contentFrame()
    .locator('body')
    .evaluate((body) => body.querySelectorAll('style').length)
  expect(sheets).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
})

test('an SVG stylesheet is read too, and so is one that only nests a face', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const source = `url(data:font/woff2;base64,${readFileSync(
    require.resolve('@fontsource/alegreya/files/alegreya-latin-400-normal.woff2')
  ).toString('base64')})`
  // A <style> inside inline SVG sits in the SVG namespace, where `nodeName` is
  // lowercase, and it styles the whole document just the same.
  await setBody(
    app,
    `<svg><style>@font-face{font-family:SvgFace;src:${source}}</style></svg>` +
      `<style>@layer late{@font-face{font-family:LayerFace;src:${source}}}</style>` +
      `<div style="background:#0aa3d2">Lunch plans</div>`
  )
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')

  const families = await framedFamilies(page)
  expect(families).not.toContain('SvgFace')
  expect(families).not.toContain('LayerFace')
  await page.keyboard.press('Escape')
})

test('a sheet with no face of its own keeps its exact text', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  // Reserializing through the CSSOM would drop the hacks and unknown at-rules
  // ordinary mail leans on, so a sheet that declares no face is not rewritten.
  const css = '@media all{p{color:#123456}}@font-feature-values Fancy{@styleset{x:1}}p{*zoom:1}'
  await setBody(app, `<style>${css}</style><div style="background:#0aa3d2">Lunch plans</div>`)
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')

  const frame = page.getByTestId('html-body-frame')
  await expect(frame).toBeVisible()
  const kept = await frame
    .contentFrame()
    .locator('body')
    .evaluate((body) => body.querySelector('style')?.textContent ?? '')
  // Byte for byte. An unknown at-rule and an IE hack are here because the
  // CSSOM drops both, so a rewrite would be visible in ordinary mail.
  expect(kept).toBe(css)
  await page.keyboard.press('Escape')
})
