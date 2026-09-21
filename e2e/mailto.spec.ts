import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'
import { emitSeam, openMailto, setDefaultMailClient } from './seams'

// F16: `mailto:` deep links. The seam feeds a URL through the same
// `handleMailtoUrl` the OS reaches on macOS (`open-url`), on Windows and Linux
// (a second instance's command line), and at a cold start. The OS registration
// itself is faked: no suite may change a developer's default mail app.

test.use({ seed: 'fixtures/seed-inbox.json' })

const artifactDirectory = join(__dirname, '.artifacts')

test('a mailto link opens the full-window composer with its fields', async ({ app, page }, testInfo) => {
  const composer = new ComposerPage(page)
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })

  await openMailto(
    app,
    'mailto:alex%2Bplans@example.com?cc=sam@example.com&subject=Q3%20plan&body=First%20line%0D%0A%0D%0ASecond%20line'
  )

  await composer.root.waitFor()
  // A `+` in the address survives: the parser never hands the query to
  // URLSearchParams, which would decode it as a space.
  await composer.expectRecipients(['alex+plans@example.com'])
  await composer.expectRecipients(['sam@example.com'], 'cc')
  await expect(composer.subject).toHaveValue('Q3 plan')
  // The blank line between the two paragraphs survives as its own empty row.
  await expect
    .poll(() => composer.editor.locator('p').evaluateAll((rows) => rows.map((row) => row.textContent)))
    .toEqual(['First line', '', 'Second line'])

  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'mailto-composer.png')
  await page.screenshot({ path })
  await testInfo.attach('mailto-composer', { path, contentType: 'image/png' })

  // The link's fields were written when the draft was created, so closing it
  // needs no further edit: the row is already in Drafts with them.
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  const row = page.getByTestId('draft-row').filter({ hasText: 'Q3 plan' })
  await expect(row).toHaveCount(1)
  await row.click()
  await composer.root.waitFor()
  await composer.expectRecipients(['alex+plans@example.com'])
  await composer.expectRecipients(['sam@example.com'], 'cc')
  await expect(composer.editor).toContainText('Second line')
})

test('a body carrying markup renders as literal text, never as elements', async ({ app, page }) => {
  const composer = new ComposerPage(page)
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })

  await openMailto(
    app,
    `mailto:alex@example.com?body=${encodeURIComponent('<img src=x onerror=alert(1)> & <b>bold</b>')}`
  )

  await composer.root.waitFor()
  await expect(composer.editor).toContainText('<img src=x onerror=alert(1)> & <b>bold</b>')
  await expect(composer.editor.locator('img')).toHaveCount(0)
  await expect(composer.editor.locator('b')).toHaveCount(0)
})

test('a link with no body still gets the account signature', async ({ app, page }) => {
  const composer = new ComposerPage(page)
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await emitSeam(app, TEST_CHANNELS.setSendAsSignature, '<div>Best,</div><div>Alex Morgan</div>')

  await openMailto(app, 'mailto:alex@example.com?subject=No%20body')

  await composer.root.waitFor()
  // An empty body is still an empty draft, so F6 inserts the defaults; a link
  // that carries a body is authored content and gets none.
  await expect(composer.signature).toHaveCount(1)
  await composer.revealSignature()
  await expect(composer.signature.getByText('Alex Morgan')).toBeVisible()
})

test('a link that arrives while a draft is open leaves that draft alone', async ({ app, page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('kim@example.com')
  await composer.expectSaved()

  await openMailto(app, 'mailto:alex@example.com?subject=Interrupting')

  await expect(page.getByTestId('toast')).toContainText('Close the open draft to write to alex@example.com')
  await composer.expectRecipients(['kim@example.com'])
  await expect(composer.subject).toHaveValue('')
  // The link was consumed, so closing this draft must not spring a composer.
  // One second covers the pull the closing renderer would make.
  await composer.editor.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await page.waitForTimeout(1_000)
  await expect(composer.root).toHaveCount(0)
})

test('a link that arrives while Settings is open closes Settings and shows the composer', async ({
  app,
  page
}) => {
  const composer = new ComposerPage(page)
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await runPaletteCommand(page, 'Open settings')
  await expect(page.getByTestId('settings-view')).toBeVisible()

  await openMailto(app, 'mailto:alex@example.com?subject=From%20Settings')

  // A composer under Settings would be hidden and still take composer keys.
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['alex@example.com'])
  await expect(composer.subject).toHaveValue('From Settings')
})

test.describe('cold start', () => {
  // Windows and Linux hand the launching link to `process.argv`. The request
  // is parked before any window exists, and the mounting renderer pulls it.
  test.use({ appArgs: ['mailto:cold@example.com?subject=Cold%20start'] })

  test('a link that launches Attn lands in the composer', async ({ page }) => {
    const composer = new ComposerPage(page)
    await composer.root.waitFor()
    await composer.expectRecipients(['cold@example.com'])
    await expect(composer.subject).toHaveValue('Cold start')
    // One link makes one draft, however many trees pulled it while mounting.
    await composer.editor.click()
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.keyboard.press('g')
    await page.keyboard.press('d')
    await expect(page.getByTestId('draft-row').filter({ hasText: 'Cold start' })).toHaveCount(1)
  })
})

test('the default email app row reports the build and claims the registration', async ({ app, page }) => {
  const settings = page.getByTestId('settings-view')
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByTestId('settings-nav-background').click()
  const row = settings.getByTestId('settings-default-mail-client')
  await expect(row).toBeVisible()
  // The e2e build is unpackaged and runs under the test profile, so the real
  // registration reports itself unsupported and the button stays inert.
  await expect(settings.getByTestId('settings-default-mail-client-note')).toContainText('installed app')
  await expect(settings.getByTestId('settings-default-mail-client-set')).toBeDisabled()

  await setDefaultMailClient(app, { supported: true, isDefault: false })
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByTestId('settings-nav-background').click()
  const claim = settings.getByTestId('settings-default-mail-client-set')
  await expect(claim).toBeEnabled()
  await claim.click()
  await expect(settings.getByTestId('settings-default-mail-client-state')).toContainText(
    'Attn is the default email app'
  )
  await expect(claim).toHaveCount(0)
  await setDefaultMailClient(app, null)
})

test('the palette command claims the registration and reports the answer', async ({ app, page }) => {
  await setDefaultMailClient(app, { supported: true, isDefault: false })
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await runPaletteCommand(page, 'Make Attn the default email app')
  await expect(page.getByTestId('toast')).toContainText('Attn is the default email app')
  await setDefaultMailClient(app, null)
})

test('the Background settings page reads correctly in both themes', async ({ page }, testInfo) => {
  const settings = page.getByTestId('settings-view')
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByTestId('settings-nav-background').click()
  await expect(settings.getByTestId('settings-default-mail-client')).toBeVisible()
  mkdirSync(artifactDirectory, { recursive: true })
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', `dispatch-${colorScheme}`)
    const path = join(artifactDirectory, `settings-background-${colorScheme}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`settings-background-${colorScheme}`, { path, contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
})
