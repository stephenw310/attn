import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-contact-hygiene.json' })

test('keeps Spam, Trash, and legacy Chat rows out of mail-derived contacts', async ({ page }) => {
  expect(await page.evaluate(() => window.attn.contacts.search('trusted'))).toEqual([
    expect.objectContaining({ email: 'trusted@example.com' })
  ])
  expect(await page.evaluate(() => window.attn.contacts.search('spam-source'))).toEqual([])
  expect(await page.evaluate(() => window.attn.contacts.search('trash-source'))).toEqual([])
  expect(await page.evaluate(() => window.attn.contacts.search('chat-source'))).toEqual([])
})
