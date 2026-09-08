import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { enableAi } from './nav'
import { aiRequests, installFakeAi } from './seams'

test.use({ seed: 'fixtures/seed-ai-context.json' })

for (const kind of ['reply', 'replyAll'] as const) {
  test(`${kind} drafting, refine, and reopened autocomplete stop at the middle message`, async ({
    app,
    page
  }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(1)
    await enableAi(page, true)
    await page.evaluate(() => window.attn.ai.setSetting('voiceMatchingEnabled', true))
    await installFakeAi(app, { chunks: ['Bounded response.'] })

    await page.getByTestId('thread-row').click()
    const messages = page.getByTestId('conversation-message')
    await expect(messages).toHaveCount(4)
    await messages.nth(1).getByTestId('older-message-toggle').click()
    await expect(messages.nth(1).getByTestId('message-cursor')).toBeVisible()
    await page.keyboard.press(kind === 'reply' ? 'r' : 'a')
    const composer = new ComposerPage(page)
    await composer.expectRecipients(['jordan@example.com'])
    await expect(page.getByTestId('conversation-latest-item')).toHaveAttribute(
      'data-composer-source-message-id',
      'm-target'
    )

    await page.keyboard.press('ControlOrMeta+j')
    await expect(page.getByTestId('ai-refine')).toBeVisible()
    await page.getByTestId('ai-refine-input').fill('shorter')
    await page.getByTestId('ai-refine-input').press('Enter')
    await expect.poll(() => aiRequests(app).then((requests) => requests.length)).toBe(2)
    await expect(page.getByTestId('ai-drafting')).toHaveCount(0)
    await composer.expectSaved()
    const draftId = await composer.root.getAttribute('data-draft-id')
    await page.getByTestId('composer-close').click()
    await expect(composer.root).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByTestId('thread-row').click()
    await expect(composer.root).toHaveAttribute('data-draft-id', draftId ?? '')
    await expect(page.getByTestId('conversation-latest-item')).toHaveAttribute(
      'data-composer-source-message-id',
      'm-target'
    )
    await composer.editor.locator('p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' More thoughts')
    await expect(page.getByTestId('ai-autocomplete-preview')).toBeVisible()

    const requests = await aiRequests(app)
    expect(requests.map((request) => request.purpose)).toEqual(['reply', 'refine', 'autocomplete'])
    for (const request of requests) {
      const conversation = request.messages.map((message) => message.content).join('\n')
      expect(conversation).toContain('Earlier account question.')
      expect(conversation).toContain('Selected message asking for help.')
      const payload = `${request.system}\n${conversation}`
      expect(payload).not.toContain('Later internal account notes.')
      expect(payload).not.toContain('Later private sent reply.')
      expect(payload).not.toContain('Style signature company.')
      expect(payload).not.toContain('Quoted colleague style text.')
      expect(payload).not.toContain('Plain style signature.')
      expect(payload).not.toContain('Plain quoted colleague text.')
      if (request.purpose === 'autocomplete') {
        expect(payload).not.toContain('Unrelated writing style example.')
        expect(payload).not.toContain('Another authored style example.')
      } else {
        expect(request.system).toContain('Unrelated writing style example.')
        expect(request.system).toContain('Another authored style example.')
      }
    }
  })
}
