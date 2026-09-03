import type { Page } from '@playwright/test'
import { expect, test } from './electron'
import { aiRequests, installFakeAi } from './seams'

// T36 (F17): the AI writing foundation — consent flows, key custody, the
// scripted generation round trip through the production main-process
// transport, and the acceptance guarantee that disabled state reaches no
// provider, including after relaunch. The fake provider seam is the only
// endpoint anywhere in this suite; real endpoints stay out of e2e.

test.use({ seed: 'fixtures/seed-inbox.json' })

/** Run one generation from the renderer, collecting the streamed text. */
function generateText(page: Page, request: unknown): Promise<string> {
  return page.evaluate(
    (input) =>
      new Promise<string>((resolve, reject) => {
        let buffer = ''
        const stop = window.attn.ai.onStreamEvent((event) => {
          if (event.kind === 'chunk') buffer += event.text
          else if (event.kind === 'done') {
            stop()
            resolve(buffer)
          } else {
            stop()
            reject(new Error(event.message))
          }
        })
        window.attn.ai.generate(input as Parameters<typeof window.attn.ai.generate>[0]).catch((error) => {
          stop()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      }),
    request
  )
}

function generateError(page: Page, request: unknown): Promise<string> {
  return page.evaluate(
    (input) =>
      window.attn.ai
        .generate(input as Parameters<typeof window.attn.ai.generate>[0])
        .then(() => 'unexpectedly started')
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
    request
  )
}

const replyRequest = { purpose: 'reply', thread: [{ author: 'Maya Lin', text: 'Ping?' }] }

async function openAiSettings(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+,')
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByTestId('settings-ai')).toBeVisible()
}

test('enabling shows the disclosure, a key round-trips, and a scripted generation streams', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await openAiSettings(page)

  // Enable is a consent flow: the checkbox alone writes nothing — the
  // disclosure panel's confirm does.
  await page.getByTestId('settings-ai-enabled').click()
  const disclosure = page.getByTestId('settings-ai-enable-confirm')
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText('reply text you have already written')
  await expect(disclosure).toContainText('using your own key')
  await expect(disclosure).toContainText('cannot be recalled')
  await expect(page.getByTestId('settings-ai-enabled')).not.toBeChecked()
  await page.getByTestId('settings-ai-enable-apply').click()
  await expect(page.getByTestId('settings-ai-enabled')).toBeChecked()

  // Enabling reply drafting never enables autocomplete (F17).
  await expect(page.getByTestId('settings-ai-autocomplete')).not.toBeChecked()

  // Key round trip: saved keys show presence only, never the value.
  await page.getByTestId('settings-ai-key-input').fill('sk-test-key-e2e')
  await page.getByTestId('settings-ai-key-save').click()
  await expect(page.getByTestId('settings-ai-key-present')).toBeVisible()
  await expect(page.getByTestId('settings-ai-key-input')).toHaveCount(0)

  // A scripted generation streams through the production transport.
  await installFakeAi(app, { chunks: ['Hello', ' world'] })
  expect(await generateText(page, replyRequest)).toBe('Hello world')
  const afterGenerate = await aiRequests(app)
  expect(afterGenerate).toHaveLength(1)
  expect(afterGenerate[0].purpose).toBe('reply')
  expect(afterGenerate[0].messages[0].content).toContain('Ping?')

  // Removing the key disables both features and blocks further generation.
  await page.getByTestId('settings-ai-key-remove').click()
  await expect(page.getByTestId('settings-ai-key-input')).toBeVisible()
  await expect(page.getByTestId('settings-ai-enabled')).not.toBeChecked()
  expect(await generateError(page, replyRequest)).toContain('disabled')
  expect(await aiRequests(app)).toHaveLength(1)
})

test('disabled AI reaches no provider: Mod+J hints, the bridge rejects, and relaunch stays off', async ({
  app,
  boot,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await installFakeAi(app)

  // The command exists from the reader but only points at Settings while off.
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByTestId('toast')).toContainText('Enable AI writing in Settings')

  expect(await generateError(page, replyRequest)).toContain('disabled')
  expect(await aiRequests(app)).toHaveLength(0)

  // Still off after relaunch: zero requests to any endpoint (F17 acceptance).
  const { app: relaunchedApp, page: relaunched } = await boot.relaunch()
  await installFakeAi(relaunchedApp)
  expect(await generateError(relaunched, replyRequest)).toContain('disabled')
  expect(await aiRequests(relaunchedApp)).toHaveLength(0)
})

test('autocomplete consent is separate, gates its own requests, and survives relaunch', async ({
  app,
  boot,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await installFakeAi(app, { chunks: ['never'] })
  await page.evaluate(() => window.attn.ai.setSetting('enabled', true))

  const autocompleteRequest = { purpose: 'autocomplete', prefix: 'Hi t', suffix: '' }
  expect(await generateError(page, autocompleteRequest)).toContain('autocomplete')
  expect(await aiRequests(app)).toHaveLength(0)

  // The autocomplete opt-in has its own disclosure naming the typing traffic.
  await openAiSettings(page)
  await expect(page.getByTestId('settings-ai-enabled')).toBeChecked()
  await page.getByTestId('settings-ai-autocomplete').click()
  const disclosure = page.getByTestId('settings-ai-autocomplete-confirm')
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText('While you type')
  await expect(disclosure).toContainText('current subject')
  await expect(disclosure).toContainText('selected tone and standing rules')
  await page.getByTestId('settings-ai-autocomplete-cancel').click()
  await expect(page.getByTestId('settings-ai-autocomplete')).not.toBeChecked()

  // Master on, autocomplete off is exactly what a relaunch must preserve.
  const { app: relaunchedApp, page: relaunched } = await boot.relaunch()
  const settings = await relaunched.evaluate(() => window.attn.ai.getSettings())
  expect(settings.enabled).toBe(true)
  expect(settings.autocompleteEnabled).toBe(false)
  await installFakeAi(relaunchedApp)
  expect(await generateError(relaunched, autocompleteRequest)).toContain('autocomplete')
  expect(await aiRequests(relaunchedApp)).toHaveLength(0)
})
