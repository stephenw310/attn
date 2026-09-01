import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ATTN_SIGNATURE_LINE } from '../src/shared/settings'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

// T37A (F17): inline autocomplete under the fake provider — the separate
// consent, the debounced typing trigger, the transient gray preview that
// never enters the persisted draft, Tab acceptance as one undo step, Esc
// dismissal, protected-region suppression, and silent failure. Zero real
// endpoints; the request payload recorded by the seam is the privacy proof.

test.use({ seed: 'fixtures/seed-inbox.json' })

async function emitSeam(app: ElectronApplication, channel: string, request?: unknown): Promise<void> {
  const error = await app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(input.channel, {}, input.request, resolve)),
    { channel, request }
  )
  if (error) throw new Error(error)
}

function installFakeAi(app: ElectronApplication, script: unknown): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.installFakeAiProvider, script)
}

interface RecordedRequest {
  purpose: string
  system: string
  messages: Array<{ role: string; content: string }>
  canceled: boolean
}

function aiRequests(app: ElectronApplication): Promise<RecordedRequest[]> {
  return app.evaluate(
    ({ ipcMain }, channel) => new Promise<RecordedRequest[]>((resolve) => ipcMain.emit(channel, {}, resolve)),
    TEST_CHANNELS.aiProviderRequests
  )
}

async function enableAi(page: Page, autocomplete: boolean): Promise<void> {
  await page.evaluate(async (auto) => {
    await window.attn.ai.setKey('sk-e2e-test')
    await window.attn.ai.setSetting('enabled', true)
    if (auto) await window.attn.ai.setSetting('autocompleteEnabled', true)
  }, autocomplete)
}

const editor = (page: Page) => page.getByTestId('composer-editor')
const preview = (page: Page) => page.getByTestId('ai-autocomplete-preview')

async function openDesignReply(page: Page): Promise<ComposerPage> {
  await page.getByTestId('thread-row').filter({ hasText: 'Design notes' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const composer = new ComposerPage(page)
  await composer.openReply()
  return composer
}

test('an AI-ready reply shows its shortcut tip, then completes the recipient name locally', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, false)
  await openDesignReply(page)

  const tip = page.getByTestId('composer-ai-tip')
  await expect(tip).toContainText(/Tip: Hit (⌘|Ctrl)J for AI/)
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Hi')

  await expect(tip).toHaveCount(0)
  await expect(preview(page)).toContainText('Theo,')
  expect(await aiRequests(app)).toHaveLength(0)

  await page.keyboard.press('Tab')
  await expect(editor(page)).toContainText('Hi Theo,')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).toContainText('Hi')
  await expect(editor(page)).not.toContainText('Theo')

  // Accepting the local greeting must not poison later provider completion.
  // Rebuild the greeting after proving its one-step undo, then pause after a
  // sentence fragment on the next paragraph.
  await page.keyboard.type(' Theo,')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.evaluate(async () => window.attn.ai.setSetting('autocompleteEnabled', true))
  await installFakeAi(app, { chunks: [' hiring next week.'] })
  await page.keyboard.type('We are')
  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(1)
  const requests = await aiRequests(app)
  expect(requests[0].messages.at(-1)?.content).toContain('Hi Theo,\n\nWe are')
  await expect(preview(page)).toContainText('hiring next week.')
})

test('reply drafting alone sends no typing traffic; the opt-in suggests, Tab accepts as one undo', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, false)
  await installFakeAi(app, { chunks: ['never delivered'] })
  await openDesignReply(page)
  // Click the authored first line. The default attribution stays editable,
  // but autocomplete intentionally ignores that protected footer region.
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Thanks for the')
  await page.waitForTimeout(800)
  expect(await aiRequests(app)).toHaveLength(0)
  await expect(preview(page)).toHaveCount(0)

  // The separate opt-in turns typing pauses into bounded requests.
  await page.evaluate(async () => {
    await window.attn.ai.setSetting('voiceTone', 'formal')
    await window.attn.ai.setSetting('voiceRules', 'Avoid exclamation marks.')
    await window.attn.ai.setSetting('autocompleteEnabled', true)
  })
  await installFakeAi(app, { chunks: [' notes — the overlay reads well.'] })
  await page.keyboard.type(' d')
  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(1)
  await expect(preview(page)).toBeVisible()
  await expect(preview(page)).toContainText('the overlay reads well.')

  const requests = await aiRequests(app)
  expect(requests).toHaveLength(1)
  expect(requests[0].purpose).toBe('autocomplete')
  const payload = requests[0].system + requests[0].messages.map((message) => message.content).join('')
  expect(payload).toContain('Thanks for the d')
  // Reply suggestions use the live subject, voice profile, and current
  // conversation, but never unrelated sent-mail style examples.
  expect(payload).toContain('Design notes')
  expect(payload).toContain('formal')
  expect(payload).toContain('Avoid exclamation marks.')
  expect(payload).toContain('The conversation overlay direction feels focused.')
  expect(payload).not.toContain('Recent replies the user wrote')

  // Tab inserts the suggestion as editable text, one undo step.
  await page.keyboard.press('Tab')
  await expect(preview(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('Thanks for the d notes — the overlay reads well.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).not.toContainText('the overlay reads well.')
  await expect(editor(page)).toContainText('Thanks for the d')
})

test('Esc dismisses without closing, and an unaccepted preview never reaches the saved draft', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, true)
  await installFakeAi(app, { chunks: [' phantom suggestion text'] })
  const composer = await openDesignReply(page)
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Hello ther')
  await expect(preview(page)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(preview(page)).toHaveCount(0)
  await expect(composer.root).toBeVisible()

  // A fresh pause after more typing may suggest again (rate limit allows a
  // second start after a second).
  await page.waitForTimeout(1_100)
  await page.keyboard.type('e')
  await expect(preview(page)).toBeVisible()

  // Close with the preview showing; the reopened draft has only typed text.
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await page.getByTestId('draft-row').filter({ hasText: 'Design notes' }).click()
  await expect(composer.root).toBeVisible()
  await expect(editor(page)).toContainText('Hello there')
  expect(await editor(page).innerText()).not.toContain('phantom')
})

test('stop-and-start typing coalesces the latest request through the cooldown', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, true)
  await installFakeAi(app, { chunks: [' latest suggestion'], delayMs: 700 })
  await page.keyboard.press('c')
  await editor(page).click({ position: { x: 24, y: 24 } })

  await page.keyboard.type('Hello')
  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(1)
  await page.keyboard.type(' again')

  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(2)
  await expect.poll(() => aiRequests(app).then((requests) => requests[0]?.canceled)).toBe(true)
  await expect(preview(page)).toContainText('latest suggestion')
  await expect(editor(page)).toContainText('Hello again')
})

test('a caret in the Attn footer never requests; provider failure yields silence, not toasts', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, true)
  await page.evaluate(() => window.attn.settings.setAccount('seed@attn.test', 'attnSignatureEnabled', true))
  await installFakeAi(app, { chunks: ['must not appear'] })
  await openDesignReply(page)

  // Type inside the footer region: suppressed outright.
  const footerLine = editor(page).getByText(ATTN_SIGNATURE_LINE)
  await footerLine.click()
  await page.keyboard.type('x')
  await page.waitForTimeout(800)
  expect(await aiRequests(app)).toHaveLength(0)
  await expect(preview(page)).toHaveCount(0)

  // A failing provider produces no suggestion and no error surface.
  await installFakeAi(app, { error: 'provider exploded' })
  await editor(page).click({ position: { x: 40, y: 12 } })
  await page.keyboard.type('Hello worl')
  await page.waitForTimeout(900)
  expect((await aiRequests(app)).length).toBeGreaterThanOrEqual(1)
  await expect(preview(page)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  // Typing stays ordinary.
  await page.keyboard.type('d')
  await expect(editor(page)).toContainText('Hello world')
})

test('suggestions render legibly at the caret in dark and light themes (artifacts)', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, true)
  await installFakeAi(app, { chunks: [' to share a quick update on the design review.'] })

  // New-message composer: autocomplete covers every composer kind.
  await page.keyboard.press('c')
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Dear team, I wanted')
  await expect(preview(page)).toBeVisible()
  await page.screenshot({ path: 'e2e/.artifacts/ai-autocomplete.png' })

  // Light theme via the real theme picker; a fresh pause re-suggests there.
  await page.keyboard.press('Escape')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('theme-picker').selectOption('dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1_100)
  await page.keyboard.press('c')
  await expect(composer.root).toBeVisible()
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Dear team, I wanted')
  await expect(preview(page)).toBeVisible()
  await page.screenshot({ path: 'e2e/.artifacts/ai-autocomplete-light.png' })
})
