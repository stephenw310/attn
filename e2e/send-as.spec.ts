import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'
import { emitSeam } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

for (const appearance of ['dark', 'light'] as const) {
  test(`Gmail send-as selection persists in ${appearance} theme`, async ({ app, page, boot }, testInfo) => {
    await page.getByTestId('thread-list').waitFor()
    await emitSeam(app, TEST_CHANNELS.setSendAsIdentities, [
      { sendAsEmail: 'work@example.org', displayName: 'Work Identity', verificationStatus: 'accepted' },
      { sendAsEmail: 'pending@example.org', verificationStatus: 'pending' }
    ])
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    const composer = new ComposerPage(page)
    await composer.openNew()
    const from = page.getByTestId('composer-from-select')
    await runPaletteCommand(page, 'Choose sender address')
    await expect(from).toBeFocused()
    await from.press('ArrowDown')
    await expect(page.getByTestId('composer-from-option')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composer-from-menu')).toBeHidden()
    await expect(from).toBeFocused()
    await from.press('Enter')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('composer-from')).toHaveAttribute('data-email', 'work@example.org')
    await composer.addRecipient('recipient@example.com')
    await composer.subject.fill('Sender persistence')
    await composer.editor.fill('This draft uses my work identity.')
    await composer.expectSaved()
    const dir = join('e2e', '.artifacts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `send-as-full-${appearance}.png`)
    await page.getByTestId('composer-from-select').click()
    await page.screenshot({ path })
    await page.keyboard.press('Escape')
    await testInfo.attach('send-as-full', { path, contentType: 'image/png' })
    await page.getByTestId('composer-close').click()
    const relaunched = await boot.relaunch()
    await runPaletteCommand(relaunched.page, 'Go to Drafts')
    await relaunched.page.getByTestId('draft-row').filter({ hasText: 'Sender persistence' }).click()
    await expect(relaunched.page.getByTestId('composer-from')).toHaveAttribute(
      'data-email',
      'work@example.org'
    )
    await expect(relaunched.page.getByTestId('composer-editor')).toContainText(
      'This draft uses my work identity.'
    )
  })

  test(`inline replies expose Gmail send-as in ${appearance} theme`, async ({ app, page }, testInfo) => {
    await page.getByTestId('thread-list').waitFor()
    await emitSeam(app, TEST_CHANNELS.setSendAsIdentities, [
      { sendAsEmail: 'work@example.org', displayName: 'Work Identity', verificationStatus: 'accepted' }
    ])
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    await threadRow(page, 'Q3 roadmap review').click()
    await page.keyboard.press('Enter')
    const composer = new ComposerPage(page)
    await composer.openReply()
    await page.getByTestId('composer-from-select').click()
    await page.getByTestId('composer-from-option').filter({ hasText: 'work@example.org' }).click()
    await composer.editor.fill('Reply from my work identity.')
    await composer.expectSaved()
    const dir = join('e2e', '.artifacts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `send-as-inline-${appearance}.png`)
    await page.getByTestId('composer-from-select').click()
    await page.screenshot({ path })
    await page.keyboard.press('Escape')
    await testInfo.attach('send-as-inline', { path, contentType: 'image/png' })
  })
}

test.describe('source message identity', () => {
  test.use({ seed: 'fixtures/seed-send-as.json' })
  for (const [source, command, expected] of [
    ['received', 'Reply', 'work@example.org'],
    ['received', 'Reply all', 'work@example.org'],
    ['received', 'Forward', 'work@example.org'],
    ['sent', 'Reply', 'work@example.org'],
    ['sent', 'Forward', 'work@example.org'],
    ['unmatched', 'Reply', 'default@example.org']
  ]) {
    test(`${command} uses the ${source} identity`, async ({ app, page }) => {
      await page.getByTestId('thread-list').waitFor()
      await emitSeam(app, TEST_CHANNELS.setSendAsIdentities, [
        {
          sendAsEmail: 'work@example.org',
          verificationStatus: 'accepted',
          signature: '<p>Work signature</p>'
        },
        {
          sendAsEmail: 'default@example.org',
          verificationStatus: 'accepted',
          isDefault: true,
          signature: '<p>Default signature</p>'
        }
      ])
      await threadRow(page, `${source} identity`).click()
      await page.keyboard.press(command === 'Forward' ? 'f' : command === 'Reply all' ? 'a' : 'r')
      const composer = new ComposerPage(page)
      await expect(page.getByTestId('composer-from')).toHaveAttribute('data-email', expected)
      await composer.revealSignature()
      await expect(composer.editor).toContainText(
        expected === 'work@example.org' ? 'Work signature' : 'Default signature'
      )
    })
  }
})
