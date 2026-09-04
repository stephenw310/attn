import type { ElectronApplication, Page } from '@playwright/test'
import { AUTOCOMPLETE_DEBOUNCE_MS, AUTOCOMPLETE_MIN_START_INTERVAL_MS } from '../src/shared/ai'
import { ATTN_SIGNATURE_LINE } from '../src/shared/settings'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { enableAi } from './nav'
import { aiRequests, flushRendererIpc, installFakeAi } from './seams'

// T37A (F17): inline autocomplete under the fake provider — the separate
// consent, the debounced typing trigger, the transient gray preview that
// never enters the persisted draft, Tab acceptance as one undo step, Esc
// dismissal, protected-region suppression, and silent failure. Zero real
// endpoints; the request payload recorded by the seam is the privacy proof.

test.use({ seed: 'fixtures/seed-inbox.json' })

/**
 * Both autocomplete intervals are real time, not renderer time (T3): the
 * debounce runs on the controller's timers, but the one-start-per-second
 * cooldown is enforced by the main-process transport on its own clock, which
 * `page.clock` cannot reach — a faked renderer clock dispatches into a
 * limiter that still refuses. So these waits stay wall-clock, and are derived
 * from the constants they are keyed to rather than picked by hand.
 */
async function waitOutStartCooldown(page: Page): Promise<void> {
  await page.waitForTimeout(AUTOCOMPLETE_MIN_START_INTERVAL_MS + 100)
}

/**
 * Prove typing started no request: give the debounce the edit armed its full
 * delay, then let the dispatch it would have made cross IPC twice — the
 * consent read and the request itself — before reading the recorder.
 */
async function expectNoRequestAfterDebounce(app: ElectronApplication, page: Page): Promise<void> {
  await page.waitForTimeout(AUTOCOMPLETE_DEBOUNCE_MS + 200)
  await flushRendererIpc(page)
  expect(await aiRequests(app)).toHaveLength(0)
}

const editor = (page: Page) => page.getByTestId('composer-editor')
const preview = (page: Page) => page.getByTestId('ai-autocomplete-preview')

async function expectPreviewBaselineAligned(page: Page): Promise<void> {
  const delta = await page.evaluate(() => {
    const authoredLine = document.querySelector<HTMLElement>('[data-testid="composer-editor"] > p')
    const suggestion = document.querySelector<HTMLElement>('[data-testid="ai-autocomplete-preview"]')
    if (!authoredLine || !suggestion) return Number.POSITIVE_INFINITY
    const authoredRange = document.createRange()
    authoredRange.selectNodeContents(authoredLine)
    const suggestionRange = document.createRange()
    suggestionRange.selectNodeContents(suggestion)
    return Math.abs(authoredRange.getBoundingClientRect().top - suggestionRange.getBoundingClientRect().top)
  })
  expect(delta).toBeLessThan(1)
}

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
  await expectNoRequestAfterDebounce(app, page)
  await expect(preview(page)).toHaveCount(0)

  // The separate opt-in turns typing pauses into bounded requests.
  await page.evaluate(async () => {
    await window.attn.ai.setSetting('voiceTone', 'formal')
    await window.attn.ai.setSetting('voiceRules', 'Avoid exclamation marks.')
    await window.attn.ai.setSetting('autocompleteEnabled', true)
  })
  await installFakeAi(app, {
    chunks: [' notes — the overlay reads well. A second sentence must stay hidden.']
  })
  await page.keyboard.type(' d')
  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(1)
  await expect(preview(page)).toBeVisible()
  await expect(preview(page)).toContainText('the overlay reads well.')
  await expect(preview(page)).not.toContainText('second sentence')

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
  await expect(editor(page)).not.toContainText('second sentence')
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
  await waitOutStartCooldown(page)
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

test('typing in the middle of existing body text does not request or show autocomplete', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, false)
  await installFakeAi(app, { chunks: [' overlapping suggestion'] })
  await page.keyboard.press('c')
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Hello existing ending')

  await page.evaluate(async () => window.attn.ai.setSetting('autocompleteEnabled', true))
  for (let index = 0; index < 'ending'.length; index += 1) await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('x')

  await expect(editor(page)).toContainText('Hello existing xending')
  await expectNoRequestAfterDebounce(app, page)
  await expect(preview(page)).toHaveCount(0)
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
  await expectNoRequestAfterDebounce(app, page)
  await expect(preview(page)).toHaveCount(0)

  // A failing provider produces no suggestion and no error surface.
  await installFakeAi(app, { error: 'provider exploded' })
  await editor(page).click({ position: { x: 40, y: 12 } })
  await page.keyboard.type('Hello worl')
  await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBeGreaterThanOrEqual(1)
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
  await expectPreviewBaselineAligned(page)
  await page.screenshot({ path: 'e2e/.artifacts/ai-autocomplete.png' })

  // Light theme via the real theme picker; a fresh pause re-suggests there.
  await page.keyboard.press('Escape')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('theme-picker').selectOption('dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await page.keyboard.press('Escape')
  await waitOutStartCooldown(page)
  await page.keyboard.press('c')
  await expect(composer.root).toBeVisible()
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('Dear team, I wanted')
  await expect(preview(page)).toBeVisible()
  await expectPreviewBaselineAligned(page)
  await page.screenshot({ path: 'e2e/.artifacts/ai-autocomplete-light.png' })
})

test('a long suggestion moves to the next line instead of wrapping from the caret', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page, true)
  await installFakeAi(app, {
    chunks: [' and share the agenda in advance so everyone has enough time to prepare for the discussion.']
  })

  await page.keyboard.press('c')
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await editor(page).evaluate((root) => {
    const container = root.parentElement
    if (container) container.style.width = '520px'
  })
  await editor(page).click({ position: { x: 24, y: 24 } })
  await page.keyboard.type('We are planning to meet on Tuesday')
  await expect(preview(page)).toBeVisible()

  const editorTextLeft = await editor(page).evaluate((root) => {
    const box = root.getBoundingClientRect()
    return box.left + Number.parseFloat(getComputedStyle(root).paddingLeft)
  })
  const previewBox = await preview(page).boundingBox()
  expect(previewBox).not.toBeNull()
  expect(Math.abs((previewBox?.x ?? 0) - editorTextLeft)).toBeLessThan(3)
})
