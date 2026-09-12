import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

// T34 (F8): snippets — manager CRUD in Settings, palette insertion, the Mod+;
// picker, and the inline `;trigger ` expansion as one undoable Lexical step
// with {cursor} caret placement.

test.use({ seed: 'fixtures/seed-inbox.json' })

interface SnippetInput {
  name: string
  trigger?: string
  subject?: string
  body: string
}

async function createSnippet(page: Page, input: SnippetInput): Promise<void> {
  // The global shortcut needs the mounted command registry; the seeded list
  // rendering is the same readiness signal the settings suite keys on.
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-snippets').click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.getByTestId('settings-snippet-new').click()
  await page.getByTestId('settings-snippet-name').fill(input.name)
  if (input.trigger) await page.getByTestId('settings-snippet-trigger').fill(input.trigger)
  if (input.subject) await page.getByTestId('settings-snippet-subject').fill(input.subject)
  await page.getByTestId('settings-snippet-body').click()
  await page.keyboard.type(input.body)
  await page.getByTestId('settings-snippet-save').click()
  await expect(snippetRow(page, input.name)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
}

function snippetRow(page: Page, name: string) {
  return page.getByTestId('settings-snippet-row').filter({ hasText: name })
}

/**
 * The composer loads its snippet catalog over IPC on mount; opening the picker
 * re-lists and renders from the very state the trigger matcher reads, so a
 * visible row proves the inline `;trigger` is armed before the test types it.
 */
async function waitForSnippetsLoaded(page: Page, name: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+;')
  await expect(page.getByTestId('snippet-picker-item').filter({ hasText: name })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('snippet-picker')).toHaveCount(0)
}

test('snippet search reuses previews while typing', async ({ page }) => {
  await createSnippet(page, { name: 'Welcome', body: 'A searchable greeting.' })
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-snippets').click()
  await expect(snippetRow(page, 'Welcome')).toBeVisible()

  await page.evaluate(() => {
    const original = DOMParser.prototype.parseFromString
    DOMParser.prototype.parseFromString = (() => {
      throw new Error('Snippet search must not parse HTML again')
    }) as typeof original
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const search = page.getByTestId('settings-snippet-search')
  await search.pressSequentially('greeting')
  await expect(snippetRow(page, 'Welcome')).toBeVisible()
  await search.fill('missing')
  await expect(page.getByTestId('settings-snippet-row')).toHaveCount(0)
  await search.fill('')
  await expect(snippetRow(page, 'Welcome')).toBeVisible()
  expect(errors).toEqual([])
})

test('Escape inside the snippet body cancels nothing and keeps Settings open (B9)', async ({ page }) => {
  // The window-level Settings Escape listener once fired for any Escape,
  // including one aimed at a Lexical field, unmounting Settings and taking the
  // in-progress edit with it.
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-snippets').click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.getByTestId('settings-snippet-new').click()
  await page.getByTestId('settings-snippet-name').fill('Draft in progress')
  await page.getByTestId('settings-snippet-body').click()
  await page.keyboard.type('Half-written body text.')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByTestId('settings-snippet-editor')).toBeVisible()
  await expect(page.getByTestId('settings-snippet-body')).toContainText('Half-written body text.')
  await expect(page.getByTestId('settings-snippet-name')).toHaveValue('Draft in progress')

  // Escape from outside a field still closes Settings.
  await page.getByTestId('settings-snippet-cancel').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
})

test('a hidden snippet editor leaves Escape to Settings', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-snippets').click()
  await page.getByTestId('settings-snippet-new').click()
  await page.getByTestId('settings-snippet-name').fill('Unsaved snippet')
  await page.getByTestId('settings-nav-appearance').click()
  await page.getByTestId('settings-nav-snippets').click()
  await expect(page.getByTestId('settings-snippet-name')).toHaveValue('Unsaved snippet')
  await page.getByTestId('settings-nav-appearance').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
})

test('the manager creates, edits, and deletes snippets, and the set survives relaunch', async ({
  boot,
  page
}, testInfo) => {
  await createSnippet(page, {
    name: 'Intr',
    trigger: 'intro',
    subject: 'Quarterly check-in',
    body: 'Glad to meet you, {cursor} - talk soon.'
  })
  await createSnippet(page, { name: 'Temp', body: 'Scratch text.' })

  // Rename through the editor; the row reflects the update in place.
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-snippets').click()
  await snippetRow(page, 'Intr').click()
  await page.getByTestId('settings-snippet-name').fill('Intro')
  await page.getByTestId('settings-snippet-save').click()
  await expect(snippetRow(page, 'Intro')).toBeVisible()
  await expect(snippetRow(page, 'Intro')).toContainText(';intro')

  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  const path = join(__dirname, '.artifacts', 'snippet-manager.png')
  await page.getByTestId('settings-snippets').scrollIntoViewIfNeeded()
  await page.screenshot({ path })
  await testInfo.attach('snippet-manager', { path, contentType: 'image/png' })

  // A duplicate trigger is rejected with the row untouched.
  await page.getByTestId('settings-snippet-new').click()
  await page.getByTestId('settings-snippet-name').fill('Clash')
  await page.getByTestId('settings-snippet-trigger').fill('intro')
  await page.getByTestId('settings-snippet-save').click()
  await expect(page.getByTestId('settings-snippet-error')).toContainText('already uses that trigger')
  await page.getByTestId('settings-snippet-cancel').click()

  await snippetRow(page, 'Temp').click()
  await page.getByTestId('settings-snippet-delete').click()
  await expect(snippetRow(page, 'Temp')).toHaveCount(0)

  const { page: relaunched } = await boot.relaunch()
  await expect(relaunched.getByTestId('thread-row')).toHaveCount(8)
  await relaunched.keyboard.press('ControlOrMeta+,')
  await relaunched.getByTestId('settings-nav-snippets').click()
  await expect(snippetRow(relaunched, 'Intro')).toBeVisible()
  await expect(snippetRow(relaunched, 'Temp')).toHaveCount(0)
  await relaunched.keyboard.press('Escape')

  // The relaunched catalog still expands inline.
  const composer = new ComposerPage(relaunched)
  await composer.openNew()
  await waitForSnippetsLoaded(relaunched, 'Intro')
  await composer.typeBody('Hi ;intro ')
  await expect(composer.editor).toContainText('Glad to meet you,')
  await expect(composer.editor).not.toContainText(';intro')
})

test('`;trigger ` expands at the caret, lands it on {cursor}, and fills only an empty subject', async ({
  page
}) => {
  await createSnippet(page, {
    name: 'Intro',
    trigger: 'intro',
    subject: 'Quarterly check-in',
    body: 'Glad to meet you, {cursor} - talk soon.'
  })

  const composer = new ComposerPage(page)
  await composer.openNew()
  await waitForSnippetsLoaded(page, 'Intro')
  await expect(composer.subject).toHaveValue('')
  // The leading literal {cursor} is user content: expansion must neither
  // delete it nor treat it as the caret target (PR #101 review).
  await composer.typeBody('{cursor} Hi ;intro ')
  await expect(composer.editor).toContainText('Glad to meet you,')
  await expect(composer.editor).not.toContainText(';intro')
  // The caret landed on the snippet's own {cursor}: the next keystroke types
  // at the marker, the literal one survives, and the snippet's is consumed.
  await page.keyboard.type('X')
  await expect(composer.editor).toContainText('{cursor} Hi Glad to meet you, X - talk soon.')
  await expect(composer.subject).toHaveValue('Quarterly check-in')

  // A mid-word semicolon stays literal, and an unknown trigger is inert.
  await composer.typeBody(' word;intro ;nope ')
  await expect(composer.editor).toContainText('word;intro')
  await expect(composer.editor).toContainText(';nope')
})

test('one Mod+Z reverses the whole expansion back to the literal trigger', async ({ page }) => {
  await createSnippet(page, {
    name: 'Intro',
    trigger: 'intro',
    body: 'Glad to meet you, {cursor} - talk soon.'
  })

  const composer = new ComposerPage(page)
  await composer.openNew()
  await waitForSnippetsLoaded(page, 'Intro')
  await composer.typeBody('Hi ;intro ')
  await expect(composer.editor).toContainText('Glad to meet you,')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(composer.editor).toContainText(';intro')
  await expect(composer.editor).not.toContainText('Glad to meet you')
})

test('the palette and the Mod+; picker insert into an empty composer without clobbering a subject', async ({
  page
}) => {
  await createSnippet(page, {
    name: 'Intro',
    trigger: 'intro',
    subject: 'Quarterly check-in',
    body: 'Glad to meet you, {cursor} - talk soon.'
  })

  // Palette: "Snippet: Intro" is a registered command inside the composer
  // (F5/F8) and the snippet's subject must not overwrite one already typed.
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Existing subject')
  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
  await page.getByTestId('command-palette-input').fill('Snippet: Intro')
  await page.getByTestId('command-palette-input').press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await expect(composer.editor).toContainText('Glad to meet you,')
  await expect(composer.subject).toHaveValue('Existing subject')

  // Close and reopen a fresh draft: the Mod+; picker inserts and the empty
  // subject now takes the snippet's.
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  const second = new ComposerPage(page)
  await second.openNew()
  await page.keyboard.press('ControlOrMeta+;')
  const item = page.getByTestId('snippet-picker-item').filter({ hasText: 'Intro' })
  await expect(item).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('snippet-picker')).toHaveCount(0)
  await expect(second.editor).toContainText('Glad to meet you,')
  await expect(second.subject).toHaveValue('Quarterly check-in')
  // The insertion left the caret at {cursor} and the editor focused.
  await page.keyboard.type('X')
  await expect(second.editor).toContainText('Glad to meet you, X - talk soon.')
})
