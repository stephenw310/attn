import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-hydration.json' })

test('opens metadata-only mail immediately and explains the signed-out provider state', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('conversation-content')).toBeVisible()
  await expect(page.getByTestId('plain-text-body')).toContainText(
    'The cached preview remains available immediately.'
  )
  await expect(page.getByTestId('body-hydration-status')).toHaveText('Full message loads when signed in')
  await expect
    .poll(() => page.evaluate(() => window.attn.mail.getConversation('t-metadata-only', false, 'normal')))
    .toMatchObject({ messages: [{ bodyState: 'signed-out' }] })
})

test('keeps the cached snippet readable while offline', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.context().setOffline(true)
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('conversation-content')).toBeVisible()
  await expect(page.getByTestId('plain-text-body')).toContainText(
    'The cached preview remains available immediately.'
  )
  await expect(page.getByTestId('body-hydration-status')).toHaveText(
    "Full message loads when you're back online"
  )

  await page.context().setOffline(false)
  await expect(page.getByTestId('body-hydration-status')).toHaveText('Full message loads when signed in')
})
