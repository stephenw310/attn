import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ATTN_SIGNATURE_LINE } from '../src/shared/settings'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

// T37 (F17): AI reply drafting end to end under the fake provider — Mod+J
// from the reader opening and streaming into the inline reply composer, the
// one-undo-step guarantee, Esc's mid-stream cancel, refine, footer
// preservation, and the normal send flow. Zero real endpoints.

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

async function enableAi(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.attn.ai.setKey('sk-e2e-test')
    await window.attn.ai.setSetting('enabled', true)
  })
}

async function armSending(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 0), TEST_CHANNELS.setUndoSendDelay)
  await emitSeam(app, TEST_CHANNELS.installSendProvider)
}

function designRow(page: Page) {
  return page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
}

async function openDesignReader(page: Page): Promise<void> {
  await designRow(page).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
}

const editor = (page: Page) => page.getByTestId('composer-editor')

test('Mod+J from the reader streams an editable draft that sends through the outbox', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, { chunks: ['Thanks for the notes.', '\nI will review the overlay today.'] })
  await openDesignReader(page)

  await page.keyboard.press('ControlOrMeta+j')
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(editor(page)).toContainText('I will review the overlay today.')
  await expect(page.getByTestId('ai-refine')).toBeVisible()

  // The recorded payload carries the conversation and, with voice matching
  // off, no sent-mail style examples (F17 acceptance).
  const requests = await aiRequests(app)
  expect(requests).toHaveLength(1)
  expect(requests[0].purpose).toBe('reply')
  const payload = requests[0].system + requests[0].messages.map((message) => message.content).join('')
  expect(payload).toContain('The conversation overlay direction feels focused.')
  expect(payload).not.toContain('Recent replies the user wrote')

  // The result is ordinary editable text behind the normal send flow.
  await editor(page).click()
  await page.keyboard.type(' Adding my own line.')
  await expect(editor(page)).toContainText('Adding my own line.')
  await armSending(app)
  await composer.triggerSend()
  await expect(composer.root).toHaveCount(0)
})

test('one undo removes the whole streamed draft and never touches the Attn footer', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await page.evaluate(() => window.attn.settings.setAccount('seed@attn.test', 'attnSignatureEnabled', true))
  await installFakeAi(app, { chunks: ['A drafted reply spanning', '\ntwo paragraphs.'] })
  await openDesignReader(page)

  await page.keyboard.press('ControlOrMeta+j')
  await expect(editor(page)).toContainText('two paragraphs.')
  // The draft lands above the footer, which stays exactly where it was.
  const text = await editor(page).innerText()
  expect(text.indexOf('two paragraphs.')).toBeLessThan(text.indexOf(ATTN_SIGNATURE_LINE))

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).not.toContainText('A drafted reply spanning')
  await expect(editor(page)).toContainText(ATTN_SIGNATURE_LINE)

  // Regenerating after the undo still yields exactly one copy of the draft
  // and one footer — generated output never adds another automatic footer.
  await installFakeAi(app, { chunks: ['Second pass draft.'] })
  await page.keyboard.press('ControlOrMeta+j')
  await expect(editor(page)).toContainText('Second pass draft.')
  const regenerated = await editor(page).innerText()
  expect(regenerated.split('Second pass draft.')).toHaveLength(2)
  expect(regenerated.split(ATTN_SIGNATURE_LINE)).toHaveLength(2)
})

test('Esc mid-stream keeps the partial text; the next Esc closes the composer normally', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, {
    chunks: ['First sentence lands.', ' Never arrives.'],
    chunkIntervalMs: 600
  })
  await openDesignReader(page)

  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('ai-drafting')).toBeVisible()
  await expect(editor(page)).toContainText('First sentence lands.')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-drafting')).toHaveCount(0)
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()

  // The canceled stream never lands its remaining chunk.
  await page.waitForTimeout(900)
  await expect(editor(page)).toContainText('First sentence lands.')
  await expect(editor(page)).not.toContainText('Never arrives')
  const requests = await aiRequests(app)
  expect(requests[0].canceled).toBe(true)

  // A second Esc is the composer's ordinary close (inline: save and exit).
  await editor(page).click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
})

test('rapid repeat invocations start exactly one generation — Esc must cancel everything', async ({
  app,
  page
}) => {
  // Two Mod+J presses during the settings/style preparation previously both
  // reached generate; Esc canceled only the later request and the first
  // streamed on, orphaned (PR #101 review). Preparation is single-flight now.
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, { chunks: ['Only one stream lands.'], chunkIntervalMs: 400 })
  await openDesignReader(page)
  const composer = new ComposerPage(page)
  await composer.openReply()

  await page.keyboard.press('ControlOrMeta+j')
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('ai-drafting')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-drafting')).toHaveCount(0)

  await page.waitForTimeout(600)
  const requests = await aiRequests(app)
  expect(requests).toHaveLength(1)
  expect(requests[0].canceled).toBe(true)
})

test('an invocation on a recovered full-window reply never parks for another draft', async ({
  boot,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await openDesignReader(page)
  let composer = new ComposerPage(page)
  await composer.openReply()
  await composer.typeBody('Recovered reply body.')
  await composer.expectSaved()

  // Relaunch with the reply still open: it recovers as the FULL-WINDOW
  // composer, which mounts no drafting plugin to serve an invocation.
  const relaunched = await boot.relaunch()
  const app = relaunched.app
  page = relaunched.page
  composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText('Recovered reply body.')
  await installFakeAi(app, { chunks: ['Must never stream.'] })

  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('toast')).toContainText(
    'Open the reply from its conversation to draft with AI'
  )
  await expect(page.getByTestId('ai-drafting')).toHaveCount(0)

  // Close the recovered draft, then open an unrelated inline reply. Without
  // conversation binding the parked invocation would fire right here, into
  // the wrong draft (PR #101 review).
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Lunch next week')
  const lunchReply = new ComposerPage(page)
  await lunchReply.openReply()
  await page.waitForTimeout(600)
  await expect(page.getByTestId('ai-drafting')).toHaveCount(0)
  await expect(editor(page)).not.toContainText('Must never stream.')
  expect(await aiRequests(app)).toHaveLength(0)
})

test('refine replaces the unedited draft as one undo step and hides after hand edits', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, { chunks: ['Original draft text.'] })
  await openDesignReader(page)

  await page.keyboard.press('ControlOrMeta+j')
  await expect(editor(page)).toContainText('Original draft text.')
  await expect(page.getByTestId('ai-refine')).toBeVisible()
  await page.screenshot({ path: 'e2e/.artifacts/ai-draft.png' })

  await installFakeAi(app, { chunks: ['Refined shorter text.'] })
  await page.getByTestId('ai-refine-input').fill('shorter')
  await page.getByTestId('ai-refine-input').press('Enter')
  await expect(editor(page)).toContainText('Refined shorter text.')
  await expect(editor(page)).not.toContainText('Original draft text.')

  const requests = await aiRequests(app)
  expect(requests).toHaveLength(2)
  expect(requests[1].purpose).toBe('refine')
  const refinePayload = requests[1].messages.map((message) => message.content).join('')
  expect(refinePayload).toContain('Original draft text.')
  expect(refinePayload).toContain('shorter')

  // One undo restores the prior draft; a hand edit then retires refine.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).toContainText('Original draft text.')
  await expect(editor(page)).not.toContainText('Refined shorter text.')
  await expect(page.getByTestId('ai-refine')).toHaveCount(0)
})
