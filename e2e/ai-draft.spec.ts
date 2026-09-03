import type { ElectronApplication, Page } from '@playwright/test'
import { IPC_CHANNELS } from '../src/shared/ipc'
import { ATTN_SIGNATURE_LINE } from '../src/shared/settings'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { enableAi, threadRow } from './nav'
import {
  aiRequests,
  armSending,
  expectResponseHeld,
  flushRendererIpc,
  holdNextResponse,
  installFakeAi
} from './seams'

// T37 (F17): AI reply drafting end to end under the fake provider — Mod+J
// from the reader opening and streaming into the inline reply composer, the
// one-undo-step guarantee, Esc's mid-stream cancel, refine, footer
// preservation, and the normal send flow. Zero real endpoints.

test.use({ seed: 'fixtures/seed-inbox.json' })

async function openDesignReader(page: Page): Promise<void> {
  await threadRow(page, 'Design notes').click()
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

test('Mod+J appends after authored text, and one undo removes only the continuation', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, {
    chunks: ['\n\nI will send comments by end of day.']
  })
  await openDesignReader(page)
  const composer = new ComposerPage(page)
  await composer.openReply()
  const original = 'Hi Maya,\n\nI can review the roadmap by Tuesday.'
  // Put the text in the authored paragraph above the protected Attn footer.
  // A bare page-level key press can inherit the footer's selection in WebKit.
  await editor(page).locator('p').first().click()
  await page.keyboard.type(original)

  await page.keyboard.press('ControlOrMeta+j')
  await expect(editor(page)).toContainText('will send comments by end of day')
  const generatedText = await editor(page).innerText()
  expect(generatedText.match(/Hi Maya,/g)).toHaveLength(1)
  expect(generatedText).toContain('I can review the roadmap by Tuesday.')

  const requests = await aiRequests(app)
  expect(requests).toHaveLength(1)
  const payload = requests[0].messages.map((message) => message.content).join('')
  expect(payload).toContain(original)
  expect(payload).toContain('Return only the new text to append')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).not.toContainText('will send comments by end of day')
  const restoredText = await editor(page).innerText()
  expect(restoredText.replace(/\s/g, '')).toContain(original.replace(/\s/g, ''))

  // A provider failure before the first chunk must leave the user text in place.
  await installFakeAi(app, { error: 'provider unavailable' })
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('toast')).toContainText('provider unavailable')
  const afterFailure = await editor(page).innerText()
  expect(afterFailure.replace(/\s/g, '')).toContain(original.replace(/\s/g, ''))
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

test('Esc mid-stream keeps partial text, then dismisses Refine before closing normally', async ({
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

  // The canceled stream never lands its remaining chunk. The provider
  // recording the cancellation is the moment after which no chunk can follow,
  // so it is the barrier to wait on — not a sleep past the chunk interval.
  await expect.poll(() => aiRequests(app).then((requests) => requests[0]?.canceled)).toBe(true)
  await flushRendererIpc(page)
  await expect(editor(page)).toContainText('First sentence lands.')
  await expect(editor(page)).not.toContainText('Never arrives')

  // The landed partial draft owns the next Esc through its Refine affordance;
  // only the following Esc is the composer's ordinary save-and-exit.
  await editor(page).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-refine')).toHaveCount(0)
  await expect(composer.root).toBeVisible()
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

  await expect.poll(() => aiRequests(app).then((requests) => requests.map((r) => r.canceled))).toEqual([true])
  await flushRendererIpc(page)
  expect(await aiRequests(app)).toHaveLength(1)
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
  await flushRendererIpc(page)
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

test('the first Esc dismisses Refine and the next saves every generated chunk', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, {
    chunks: ['First generated sentence.', '\nSecond generated sentence.', '\nFinal generated sentence.']
  })
  await openDesignReader(page)

  await page.keyboard.press('ControlOrMeta+j')
  const composer = new ComposerPage(page)
  await expect(editor(page)).toContainText('Final generated sentence.')
  await expect(page.getByTestId('ai-refine')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-refine')).toHaveCount(0)
  await expect(composer.root).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await page.getByTestId('draft-row').filter({ hasText: 'Design notes' }).click()
  await expect(composer.root).toBeVisible()
  await expect(editor(page)).toContainText('First generated sentence.')
  await expect(editor(page)).toContainText('Second generated sentence.')
  await expect(editor(page)).toContainText('Final generated sentence.')
})

test('opening Settings cancels an AI reply whose settings read is still pending', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await enableAi(page)
  await installFakeAi(app, { chunks: ['Must stay canceled.'] })
  await openDesignReader(page)
  const release = await holdNextResponse(app, IPC_CHANNELS.aiGetSettings)

  await page.keyboard.press('ControlOrMeta+j')
  await expectResponseHeld(app)
  await page.keyboard.press('ControlOrMeta+,')
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await release()

  await flushRendererIpc(page)
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('settings-view')).toBeVisible()
  expect(await aiRequests(app)).toHaveLength(0)
})

test.describe('AI replies to an individual message', () => {
  test.use({ seed: 'fixtures/seed-message-replies.json' })

  async function openOldestMessage(app: ElectronApplication, page: Page): Promise<void> {
    await expect(page.getByTestId('thread-row')).toHaveCount(1)
    await enableAi(page)
    await installFakeAi(app, { chunks: ['Source-bound reply.'] })
    await page.getByTestId('thread-row').first().click()
    await expect(page.getByTestId('message-card')).toHaveCount(3)
    await page.keyboard.press('p')
    await page.keyboard.press('p')
    await expect(page.getByTestId('conversation-message').first().getByTestId('message-cursor')).toBeVisible()
  }

  test('sends context only through the message being answered', async ({ app, page }) => {
    await openOldestMessage(app, page)
    await page.keyboard.press('ControlOrMeta+j')

    const composer = new ComposerPage(page)
    await composer.expectRecipients(['jordan+support@example.com'])
    await expect(composer.editor).toContainText('Source-bound reply.')
    const requests = await aiRequests(app)
    expect(requests).toHaveLength(1)
    const prompt = requests[0].messages.map((message) => message.content).join('')
    expect(prompt).toContain('Can you help with my account?')
    expect(prompt).not.toContain('Internal account notes.')
  })

  test('a cursor move cancels an AI invocation waiting on settings', async ({ app, page }) => {
    await openOldestMessage(app, page)
    const release = await holdNextResponse(app, IPC_CHANNELS.aiGetSettings)

    await page.keyboard.press('ControlOrMeta+j')
    await expectResponseHeld(app)
    await page.keyboard.press('n')
    await expect(page.getByTestId('conversation-message').nth(1).getByTestId('message-cursor')).toBeVisible()
    await release()

    await flushRendererIpc(page)
    await expect(page.getByTestId('composer')).toHaveCount(0)
    expect(await aiRequests(app)).toHaveLength(0)
  })
})
