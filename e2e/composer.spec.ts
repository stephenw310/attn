import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { openPalette, runPaletteCommand, selectedIndex } from './nav'

test.use({ seed: 'fixtures/seed-inbox.json' })
test.setTimeout(60_000)

async function goToDrafts(page: Page): Promise<void> {
  const draftList = page.getByTestId('draft-list')
  const threadList = page.getByTestId('thread-list')
  if (await draftList.isVisible()) return
  await expect(draftList.or(threadList)).toBeVisible()
  if (await draftList.isVisible()) return
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await draftList.waitFor()
}

async function setAttachmentPickerFiles(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ ipcMain }, input) => ipcMain.emit(input.channel, {}, input.paths), {
    channel: TEST_CHANNELS.setAttachmentPickerFiles,
    paths
  })
}

async function setSendAsSignature(app: ElectronApplication, signature: string): Promise<void> {
  const error = await app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(input.channel, {}, input.signature, resolve)),
    { channel: TEST_CHANNELS.setSendAsSignature, signature }
  )
  if (error) throw new Error(error)
}

async function pasteVisiblePng(composer: ComposerPage): Promise<void> {
  await composer.editor.evaluate(async (editor) => {
    const canvas = document.createElement('canvas')
    canvas.width = 180
    canvas.height = 72
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.fillStyle = '#ffb020'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#15171b'
    context.font = 'bold 18px sans-serif'
    context.fillText('Inline image', 30, 42)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))),
        'image/png'
      )
    )
    const file = new File([blob], 'inline-image.png', { type: 'image/png' })
    const clipboard = new DataTransfer()
    clipboard.items.add(file)
    editor.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  })
  await expect(composer.editor.locator('img')).toHaveCount(1)
}

async function pasteHtml(composer: ComposerPage, html: string): Promise<void> {
  await composer.editor.evaluate((editor, value) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/html', value)
    editor.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  }, html)
}

function remoteDraft(
  id: string,
  subject: string,
  html: string,
  bcc = '',
  inlineImage = false,
  inlineImageBase64?: string,
  extraHeaders: { name: string; value: string }[] = []
): object {
  const inlineImageData = inlineImageBase64
    ? Buffer.from(inlineImageBase64, 'base64')
    : Buffer.from([137, 80, 78, 71])
  return {
    id,
    message: {
      id: `message-${id}-${subject}`,
      threadId: `thread-${id}`,
      labelIds: ['DRAFT'],
      internalDate: String(Date.now() + 10_000),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'To', value: 'remote-to@example.com' },
          ...(bcc ? [{ name: 'Bcc', value: bcc }] : []),
          { name: 'Subject', value: subject },
          ...extraHeaders
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from(subject).toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
          ...(inlineImage
            ? [
                {
                  partId: 'remote-inline',
                  mimeType: 'image/png',
                  filename: 'remote-inline.png',
                  headers: [
                    { name: 'Content-ID', value: '<remote-inline>' },
                    { name: 'Content-Disposition', value: 'inline' }
                  ],
                  body: {
                    data: inlineImageData.toString('base64url'),
                    size: inlineImageData.byteLength
                  }
                }
              ]
            : [])
        ]
      }
    }
  }
}

function remoteReplyDraft(id: string, subject: string, html: string): object {
  return {
    id,
    message: {
      id: `message-${id}`,
      threadId: 't-roadmap',
      labelIds: ['DRAFT'],
      internalDate: String(Date.now() + 10_000),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'To', value: 'maya+roadmap@example.com' },
          { name: 'Subject', value: subject },
          { name: 'In-Reply-To', value: '<roadmap-reply@example.com>' },
          {
            name: 'References',
            value: '<roadmap-root@example.com> <roadmap-reply@example.com>'
          }
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from(subject).toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }
        ]
      }
    }
  }
}

function remoteForwardDraft(id: string, threadId: string, subject: string, html: string): object {
  return {
    id,
    message: {
      id: `message-${id}`,
      threadId,
      labelIds: ['DRAFT'],
      internalDate: String(Date.now() + 10_000),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'To', value: 'forward-to@example.com' },
          { name: 'Subject', value: subject }
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from(subject).toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }
        ]
      }
    }
  }
}

async function visiblePngBase64(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 180
    canvas.height = 72
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.fillStyle = '#ffb020'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#15171b'
    context.font = 'bold 18px sans-serif'
    context.fillText('Gmail image', 31, 42)
    const dataUrl = canvas.toDataURL('image/png')
    return dataUrl.slice(dataUrl.indexOf(',') + 1)
  })
}

function remotePlainDraft(id: string, subject: string, text: string): object {
  return {
    id,
    message: {
      id: `message-${id}-${subject}`,
      threadId: `thread-${id}`,
      labelIds: ['DRAFT'],
      internalDate: String(Date.now() + 10_000),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'To', value: 'remote-to@example.com' },
          { name: 'Subject', value: subject }
        ],
        body: { data: Buffer.from(text).toString('base64url') }
      }
    }
  }
}

test('inserts the saved Gmail signature collapsed and reveals it for editing', async ({
  app,
  page
}, testInfo) => {
  await setSendAsSignature(
    app,
    '<div style="color:#2457a6">Best,</div><div>Chao Wu</div><div><a href="https://chaowu.xyz">chaowu.xyz</a></div>'
  )
  const composer = new ComposerPage(page)
  await composer.openNew()

  const signature = composer.signature
  await expect(signature).toHaveCount(1)
  await composer.expectSignatureCollapsed()
  await expect(signature.getByText('Best,')).toBeHidden()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer-signature-collapsed.png')
  await page.screenshot({ path })
  await testInfo.attach('composer-signature-collapsed', { path, contentType: 'image/png' })

  await expect
    .poll(() => composer.editor.evaluate((element) => getComputedStyle(element).fontFamily))
    .toContain('Inter Variable')
  await expect(composer.editor).toHaveCSS('font-size', '13px')
  await expect(composer.editor).toHaveCSS('line-height', '24px')
  await composer.revealSignature()
  await expect(signature).toHaveCSS('margin-top', '20px')
  await expect(signature.locator('p').first()).toHaveCSS('margin-bottom', '0px')
  await expect(signature.locator('p').first()).toHaveCSS('min-height', '20px')
  await expect(signature.getByText('Best,')).toBeVisible()
  await expect(signature.getByText('Chao Wu')).toBeVisible()
  await expect(signature.getByRole('link', { name: 'chaowu.xyz' })).toHaveAttribute(
    'href',
    'https://chaowu.xyz'
  )
  await expect(composer.editor.locator('iframe[title="Preserved draft content"]')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)

  await composer.addRecipient('recipient@example.com')
  await composer.subject.fill('Signature check')
  await composer.editor.click({ position: { x: 24, y: 14 } })
  await page.keyboard.type('Hello from Attn')
  await composer.expectSaved()

  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find(
      (candidate) => candidate.subject === 'Signature check'
    )
    return draft ? { html: draft.bodyHtml, text: draft.bodyText } : null
  })
  expect(saved?.html).toContain('Hello from Attn')
  expect(saved?.html).not.toContain('<p')
  expect(saved?.html).toContain('class="gmail_signature"')
  expect(saved?.html).not.toContain('data-attn-signature-collapsed')
  expect(saved?.html).not.toContain('Show signature')
  expect(saved?.html.indexOf('Hello from Attn')).toBeLessThan(saved?.html.indexOf('Best,') ?? -1)
  expect(
    await page.evaluate((html) => {
      const document = new DOMParser().parseFromString(html ?? '', 'text/html')
      const signature = document.querySelector('.gmail_signature')
      return {
        text: signature?.textContent ?? '',
        direction: signature?.getAttribute('dir'),
        dedicatedWrapper:
          signature?.parentElement?.tagName === 'DIV' &&
          signature.parentElement.parentElement?.getAttribute('dir') === 'ltr' &&
          signature.parentElement.parentElement?.parentElement === document.body &&
          signature.parentElement.children.length === 1,
        spacer: signature?.parentElement?.previousElementSibling?.innerHTML ?? ''
      }
    }, saved?.html)
  ).toEqual({
    text: 'Best,Chao Wuchaowu.xyz',
    direction: 'ltr',
    dedicatedWrapper: true,
    spacer: '<br>'
  })
  expect(saved?.text).toContain('Hello from Attn')
  expect(saved?.text).toContain('Best,')
})

test('discards signature-only new mail after the saved Gmail signature changes', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.expectSignatureCollapsed()
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)

  await setSendAsSignature(app, '<div>Regards,</div><div>Chao Wu</div>')
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)
})

test('keeps legacy-font Gmail signatures editable without preview scrollbars', async ({
  app,
  page
}, testInfo) => {
  const line = (html: string): string =>
    `<div style="color:rgb(34,34,34)"><font face="arial, sans-serif">${html}</font></div>`
  const link = (label: string, href: string): string =>
    `<a href="${href}" rel="noopener noreferrer" style="color:rgb(18,100,163);text-decoration:none" target="_blank">${label}</a>`
  await setSendAsSignature(
    app,
    `<div dir="ltr">${[
      line('Best,'),
      line('Alex Rivera'),
      line(`Product @ ${link('Northstar', 'https://northstar.test/')}`),
      line(
        `${link('northstar.test', 'https://northstar.test/')} | ${link('Team', 'https://northstar.test/team')} | ${link('News', 'https://northstar.test/news')}`
      ),
      line(`Made by ${link('Northstar', 'https://northstar.test/')} | Planning software for busy teams`)
    ].join('')}</div>`
  )
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.expectSignatureCollapsed()
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  await composer.revealSignature()
  await expect(composer.editor.locator('iframe')).toHaveCount(0)
  await expect(composer.signature.locator('font')).toHaveCount(5)
  await expect(composer.signature.getByText('Alex Rivera', { exact: true })).toHaveCSS(
    'font-family',
    'arial, sans-serif'
  )
  await expect(composer.signature.getByText('Alex Rivera', { exact: true })).toHaveCSS(
    'color',
    'rgb(179, 197, 185)'
  )
  const signatureLink = composer.signature.getByRole('link', { name: 'northstar.test', exact: true })
  await expect(signatureLink).toHaveCSS('color', 'rgb(190, 209, 189)')
  await page.evaluate(() => {
    window.open = (url, target) => {
      document.body.dataset.openedSignatureLink = String(url)
      document.body.dataset.openedSignatureLinkTarget = String(target)
      return null
    }
  })
  await signatureLink.click()
  await expect
    .poll(() =>
      page.evaluate(() => ({
        target: document.body.dataset.openedSignatureLinkTarget,
        url: document.body.dataset.openedSignatureLink
      }))
    )
    .toEqual({ target: '_blank', url: 'https://northstar.test/' })
  await expect(composer.root).toBeVisible()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer-signature-font.png')
  await page.screenshot({ path })
  await testInfo.attach('composer-signature-font', { path, contentType: 'image/png' })

  // Rendering the imported font markup must not turn the default into authored content.
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.attn.draft.list())).toEqual([])

  await composer.openNew()
  await composer.revealSignature()
  await composer.signature.getByText('Alex Rivera', { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  const saved = await page.evaluate(async () => (await window.attn.draft.list())[0])
  expect(saved?.bodyText).toContain('Alex Rivera edited')
  expect(saved?.bodyHtml.match(/<font face="arial, sans-serif"/g)).toHaveLength(5)
  expect(saved?.bodyHtml).toContain('color: rgb(34, 34, 34)')
  expect(saved?.bodyHtml).toContain('https://northstar.test/team')
  expect(saved?.bodyHtml).not.toContain('iframe')
})

test('keeps automatic font direction when editing and reopening a Gmail draft', async ({ app, page }) => {
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-auto-font',
        'Automatic font direction',
        '<div dir="ltr"><font face="Arial" dir="auto">שלום Alex</font></div>'
      )
    }
  )
  if (error) throw new Error(error)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Automatic font direction' }).click()
  const composer = new ComposerPage(page)
  const font = composer.editor.locator('font')
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  await expect(font).toHaveAttribute('dir', 'auto')
  await expect(font).toHaveCSS('direction', 'rtl')
  await font.click()
  await font.evaluate((element) => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
    if (!text) throw new Error('font text missing')
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await page.keyboard.insertText('Alex ')
  await expect(font).toHaveText('Alex שלום Alex')
  await expect(font).toHaveCSS('direction', 'ltr')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  const savedDirection = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((row) => row.subject === 'Automatic font direction')
    const document = new DOMParser().parseFromString(draft?.bodyHtml ?? '', 'text/html')
    return document.querySelector('font')?.getAttribute('dir')
  })
  expect(savedDirection).toBe('auto')
  await page.getByTestId('draft-row').filter({ hasText: 'Automatic font direction' }).click()
  await expect(font).toHaveAttribute('dir', 'auto')
  await expect(font).toHaveText('Alex שלום Alex')
  await expect(font).toHaveCSS('direction', 'ltr')
})

test('keeps formatting edits made inside the saved Gmail signature', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  await composer.openNew()

  await composer.revealSignatureWithKeyboard()
  await composer.editor.getByText('Best,').selectText()
  await page.getByRole('button', { name: 'Bold' }).click()
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-selection-toolbar')).toHaveCount(0)
  await expect(composer.root).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  const drafts = await page.evaluate(async () => window.attn.draft.list())
  expect(drafts).toHaveLength(1)
  expect(drafts[0]?.bodyHtml).toContain('Best,')
  expect(drafts[0]?.bodyHtml).toMatch(/<(?:b|strong)\b/)
})

test('gives Mod+B to Bold inside the composer, not to the sidebar toggle', async ({ page }) => {
  // `layout.sidebar.toggle` is a global command that stays enabled in the
  // composer on the same keystroke; SPEC §5 gives the composer verb precedence.
  const toggle = page.getByTestId('sidebar-toggle')
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse sidebar')
  const composer = new ComposerPage(page)
  await composer.openNew()

  // Toggle the format on a collapsed caret, then type: the typed run carries it.
  await composer.typeBody('Plain ')
  await page.keyboard.press('ControlOrMeta+b')
  await composer.typeBody('Strong')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  const drafts = await page.evaluate(async () => window.attn.draft.list())
  expect(drafts).toHaveLength(1)
  expect(drafts[0]?.bodyHtml).toMatch(/<(?:b|strong)\b[^>]*>Strong<\/(?:b|strong)>/)
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse sidebar')
})

test('opens reply and forward from the selected inbox row', async ({ page }) => {
  await expect(page.getByTestId('thread-row').first()).toHaveAttribute('data-selected', 'true')

  await page.keyboard.press('r')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'reply')
  await page.getByTestId('composer-discard').click()
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()

  await page.keyboard.press('f')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
})

test('carries source attachments into a forward draft and preserves them on reopen', async ({ page }) => {
  const receipt = page.getByTestId('thread-row').filter({ hasText: 'Your receipt' })
  await receipt.click()
  await page.keyboard.press('f')

  const composer = new ComposerPage(page)
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await expect(composer.attachments).toHaveText('1 attachment')
  await expect(composer.attachmentChips).toHaveCount(1)
  await expect(composer.attachmentChips).toContainText('receipt.pdf')
  const attachment = await page.evaluate(async () => {
    const id = document.querySelector<HTMLElement>('[data-testid="composer"]')?.dataset.draftId
    return id ? (await window.attn.draft.get(id))?.attachments[0] : null
  })
  expect(attachment).toMatchObject({
    filename: 'receipt.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 24_576
  })
  expect(attachment).not.toHaveProperty('spoolPath')
  expect(attachment).not.toHaveProperty('planned')

  await composer.typeBody('Sharing this receipt.')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(receipt.getByTestId('chip-draft')).toBeVisible()

  await receipt.click()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await expect(composer.attachmentChips).toHaveCount(1)
  await expect(composer.attachmentChips).toContainText('receipt.pdf')
})

test('adds a signature and discards an untouched forward with a source attachment', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  const receipt = page.getByTestId('thread-row').filter({ hasText: 'Your receipt' })
  await receipt.click()
  await page.keyboard.press('f')
  await composer.expectSignatureAndQuoteCollapsed()
  await expect(page.getByTestId('composer-attachment-chip')).toContainText('receipt.pdf')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(receipt.getByTestId('chip-draft')).toHaveCount(0)
  await goToDrafts(page)
  await expect(page.getByTestId('draft-row').filter({ hasText: 'Your receipt' })).toHaveCount(0)
})

test('keeps a forward draft when the user removes its source attachment', async ({ page }) => {
  const receipt = page.getByTestId('thread-row').filter({ hasText: 'Your receipt' })
  await receipt.click()
  await page.keyboard.press('f')
  await expect(page.getByTestId('composer-attachment-chip')).toContainText('receipt.pdf')

  await page.getByTestId('composer-attachment-remove').click()
  await expect(page.getByTestId('composer-attachment-chip')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(receipt.getByTestId('chip-draft')).toBeVisible()

  await receipt.click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await expect(page.getByTestId('composer-attachment-chip')).toHaveCount(0)
})

test('validates recipients before queueing a send', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('This body must stay recoverable when validation fails.')

  await composer.triggerSend()

  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('composer-send-error')).toHaveText('Add at least one recipient')
  await composer.expectPending(0)
})

test('undo feedback cannot replace another open draft', async ({ page, app }) => {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 20), TEST_CHANNELS.setUndoSendDelay)
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('undo@example.com')
  await composer.subject.fill('Queued message')
  await composer.typeBody('Keep this queued while another draft is open.')
  await composer.triggerSend()
  await expect(page.getByTestId('toast-undo')).toBeVisible()
  await composer.openNew()
  await composer.subject.fill('Different draft')
  await expect(page.getByTestId('toast-undo')).toHaveCount(0)
  await expect(composer.subject).toHaveValue('Different draft')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('toast')).toHaveText('Draft saved')
  await composer.expectPending(1)
})

test('queues durably and undo send reopens the intact composer', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('undo@example.com')
  await composer.subject.fill('Undo send keeps this draft')
  await composer.typeBody('Nothing reaches the provider before the local undo window closes.')

  await composer.triggerSend()

  await expect(composer.root).toHaveCount(0)
  const toast = page.getByTestId('toast')
  await expect(toast).toHaveText(/Sending in \d+ secondsUndo Z/)
  await expect(page.getByTestId('toast-countdown')).toBeVisible()
  const timing = await toast.evaluate((element) => {
    const durationMs = Number(element.getAttribute('data-toast-duration-ms'))
    const expiresAt = Number(element.getAttribute('data-toast-expires-at'))
    const shell = element.firstElementChild
    const countdown = element.querySelector('.app-toast-countdown')
    const cssTimeMs = (value: string): number =>
      value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000
    return {
      durationMs,
      expiresAt,
      shellDurationMs: shell ? cssTimeMs(getComputedStyle(shell).animationDuration) : 0,
      countdownDurationMs: countdown ? cssTimeMs(getComputedStyle(countdown).animationDuration) : 0,
      countdownAnimation: countdown ? getComputedStyle(countdown).animationName : ''
    }
  })
  expect(timing.durationMs).toBeGreaterThan(3_500)
  expect(timing.durationMs).toBeLessThanOrEqual(5_000)
  expect(timing.expiresAt).toBeGreaterThan(Date.now() + 3_500)
  expect(Math.abs(timing.shellDurationMs - timing.durationMs)).toBeLessThan(50)
  expect(Math.abs(timing.countdownDurationMs - timing.durationMs)).toBeLessThan(50)
  expect(timing.countdownAnimation).toBe('toast-countdown')
  await composer.expectPending(1)
  await page.getByTestId('toast-undo').click()

  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['undo@example.com'])
  await expect(composer.subject).toHaveValue('Undo send keeps this draft')
  await expect(composer.editor).toContainText('Nothing reaches the provider')
  await composer.expectPending(0)
})

for (const scenario of [
  { kind: 'reply' as const, key: 'r', recipient: null },
  { kind: 'forward' as const, key: 'f', recipient: 'forward@example.com' }
]) {
  test(`shows a queued ${scenario.kind} immediately, expanded, and removes it on undo`, async ({
    app,
    page
  }) => {
    await app.evaluate(
      ({ ipcMain }, channel) => ipcMain.emit(channel, {}, 20),
      TEST_CHANNELS.setUndoSendDelay
    )
    await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
    const composer = new ComposerPage(page)
    await page.keyboard.press(scenario.key)
    await expect(composer.root).toHaveAttribute('data-draft-kind', scenario.kind)
    if (scenario.recipient) await composer.addRecipient(scenario.recipient)
    const body = `Optimistic ${scenario.kind} appears before polling.`
    await composer.typeBody(body)

    await composer.triggerSend()

    await expect(composer.root).toHaveCount(0)
    const cards = page.getByTestId('message-card')
    await expect(cards).toHaveCount(3)
    const optimistic = cards.last()
    await expect(optimistic).toHaveAttribute('data-pending', 'true')
    await expect(optimistic).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByTestId('conversation-scroll')).toBeFocused()
    await expect(optimistic.getByTestId('html-body-frame').contentFrame().locator('body')).toContainText(body)

    await page.keyboard.press('z')

    await expect(composer.root).toBeVisible()
    await expect(composer.root).toHaveAttribute('data-draft-kind', scenario.kind)
    await expect(composer.editor).toContainText(body)
    await expect(page.getByTestId('message-card')).toHaveCount(2)
    await expect(page.locator('[data-testid="message-card"][data-pending="true"]')).toHaveCount(0)
    await composer.expectPending(0)
  })
}

test('spools picked and dropped attachments through queue and relaunch, then cleans on discard', async ({
  app,
  boot,
  page,
  userData
}) => {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 0), TEST_CHANNELS.setUndoSendDelay)
  const source = join(__dirname, 'fixtures', 't17-attachment.txt')
  await setAttachmentPickerFiles(app, [source])
  let composer = new ComposerPage(page)
  await composer.openNew()
  await page.keyboard.press('ControlOrMeta+Shift+A')

  const chip = composer.attachmentChips
  await expect(chip).toContainText('t17-attachment.txt')
  await expect(chip).toContainText('37 B')
  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  await page.screenshot({ path: join(artifactDirectory, 'attachments.png') })
  const draftId = await composer.root.getAttribute('data-draft-id')
  if (!draftId) throw new Error('missing draft id')
  const spoolDirectory = join(userData, 'outbox', draftId)
  await expect.poll(() => readdirSync(spoolDirectory).length).toBe(1)
  const spooled = join(spoolDirectory, readdirSync(spoolDirectory)[0])
  expect(readFileSync(spooled, 'utf8')).toBe(readFileSync(source, 'utf8'))

  await composer.addRecipient('attachments@example.com')
  await composer.subject.fill('Durable attachment')
  await composer.triggerSend()
  await composer.expectPending(1)

  ;({ app, page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await composer.expectPending(1)
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await page.getByTestId('outbox-row').click()
  await expect(composer.attachmentChips).toContainText('t17-attachment.txt')
  await page.getByTestId('composer-attachment-remove').click()
  await expect(composer.attachmentChips).toHaveCount(0)
  await expect.poll(() => readdirSync(spoolDirectory).length).toBe(0)

  await composer.dropFiles([source])
  await expect(composer.attachmentChips).toContainText('t17-attachment.txt')
  await page.getByTestId('composer-discard').click()

  ;({ page } = await boot.relaunch())
  await expect.poll(() => existsSync(spoolDirectory)).toBe(false)
  await expect(page.getByTestId('composer')).toHaveCount(0)
})

test('rejects an oversized picked attachment without creating a chip', async ({ app, page, userData }) => {
  const source = join(userData, 'over-25mb.bin')
  writeFileSync(source, '')
  truncateSync(source, 25 * 1024 * 1024 + 1)
  await setAttachmentPickerFiles(app, [source])
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.pickAttachments()

  await expect(page.getByTestId('toast')).toHaveText('Each attachment must be 25 MB or less')
  await expect(composer.attachmentChips).toHaveCount(0)
  const error = page.getByTestId('composer-attachment-error')
  await expect(error).toContainText('Each attachment must be 25 MB or less')
  truncateSync(source, 100)
  await setAttachmentPickerFiles(app, [source])
  await runPaletteCommand(page, 'Retry attachment change')
  await expect(composer.attachmentChips).toHaveCount(1)
  await expect(error).toHaveCount(0)
  await openPalette(page, 'Retry attachment change')
  await expect(
    page.getByTestId('command-palette').getByText('Retry attachment change', { exact: true })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('renders coarse attachment upload progress in the global toast', async ({ app, page }) => {
  await page.getByTestId('thread-list').waitFor()
  const sendProgress = (): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(payload.channel, payload.progress)
        }
      },
      {
        channel: IPC_CHANNELS.outboxProgress,
        progress: {
          id: 'sending-attachment',
          completedBytes: 5,
          totalBytes: 10,
          completedAttachments: 1,
          totalAttachments: 2
        }
      }
    )

  // A real upload re-broadcasts progress continuously; this synthetic single
  // push can land in a renderer re-subscribe gap while splits settle, or be
  // wiped by the boot-time account remount right after rendering. Both
  // assertions ride the same retry so a push must survive into a settled
  // tree before the test moves on.
  await expect(async () => {
    await sendProgress()
    await expect(page.getByTestId('toast')).toContainText('Sending attachments… 1 of 2', {
      timeout: 1_000
    })
    await expect(page.getByTestId('outbox-progress')).toHaveAttribute('data-completed-attachments', '1', {
      timeout: 500
    })
  }).toPass({ timeout: 15_000 })
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(payload.channel, payload.change)
      }
    },
    {
      channel: IPC_CHANNELS.outboxChanged,
      change: { kind: 'failed', id: 'sending-attachment', error: 'Attachment send failed' }
    }
  )
  await expect(page.getByTestId('toast')).toHaveText('Attachment send failed')
  await expect(page.getByTestId('outbox-progress')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }, channel) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, null)
  }, IPC_CHANNELS.outboxProgress)
})

test('discovers a provider-gated send through the pending readout and Go to Outbox command', async ({
  app,
  boot,
  page
}) => {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 0), TEST_CHANNELS.setUndoSendDelay)
  await page.getByTestId('thread-list').waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(1)
  await page.keyboard.press('x')
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')

  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('queued@example.com')
  await composer.subject.fill('Durable provider gate')
  await composer.typeBody('This queued content survives a relaunch and reopens from Outbox.')
  await composer.triggerSend()
  await composer.expectPending(1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()

  await page.getByTestId('outbox-count').click()
  const outbox = page.getByTestId('outbox-list')
  await expect(outbox).toBeVisible()
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(page.getByTestId('outbox-row')).toHaveAttribute('data-outbox-state', 'queued')
  await expect
    .poll(async () => Number(await page.getByTestId('outbox-row').getAttribute('data-send-at')))
    .toBeLessThanOrEqual(Date.now())
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect.poll(() => selectedIndex(page)).toBe(1)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')

  // A force kill, not a quit: the queued row has to be durable on its own,
  // without a shutdown hook flushing anything on the way out (GAP-5).
  ;({ page } = await boot.relaunch({ kill: true }))
  composer = new ComposerPage(page)
  await composer.expectPending(1)
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(page.getByTestId('outbox-list')).toBeVisible()
  await page.getByTestId('outbox-row').click()

  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['queued@example.com'])
  await expect(composer.subject).toHaveValue('Durable provider gate')
  await expect(composer.editor).toContainText('survives a relaunch')
  await composer.expectPending(0)
})

test('surfaces a durable failed send without interrupting the current task', async ({ app, boot, page }) => {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 30), TEST_CHANNELS.setUndoSendDelay)
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('failed@example.com')
  await composer.subject.fill('Durable send failure')
  await composer.typeBody('The complete message must reopen after a background failure.')
  await composer.triggerSend()
  const id = await page.evaluate(async () => (await window.attn.outbox.listPending())[0]?.id)
  if (!id) throw new Error('missing queued outbox row')
  const failure = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) =>
        ipcMain.emit(args.channel, {}, args.id, args.message, resolve)
      ),
    {
      channel: TEST_CHANNELS.failOutbox,
      id,
      message: 'Recipient rejected by provider'
    }
  )
  if (failure) throw new Error(failure)
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(payload.channel, payload.change)
      }
    },
    {
      channel: IPC_CHANNELS.outboxChanged,
      change: { kind: 'failed', id, error: 'Recipient rejected by provider' }
    }
  )
  await expect(page.getByTestId('toast')).toHaveText('Recipient rejected by provider')
  await expect(composer.root).toHaveCount(0)

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toHaveCount(0)
  await composer.expectPending(1)
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(page.getByTestId('outbox-list')).toBeVisible()
  await expect(page.getByTestId('outbox-row')).toHaveAttribute('data-outbox-state', 'failed')
  // Opening the row moves it back to composing, so the reason has to be legible
  // from the list itself.
  await expect(page.getByTestId('outbox-error')).toHaveText('Recipient rejected by provider')
  await page.getByTestId('outbox-row').click()

  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('composer-send-error')).toHaveText('Recipient rejected by provider')
  await composer.expectRecipients(['failed@example.com'])
  await expect(composer.subject).toHaveValue('Durable send failure')
  await expect(composer.editor).toContainText('complete message must reopen')
  await composer.expectPending(0)
})

test('opens the composer, validates chips, autocompletes locally, and saves on Escape', async ({
  page
}, testInfo) => {
  const composer = new ComposerPage(page)
  await composer.openNew()

  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('thread-list')).toBeHidden()
  await expect(page.getByTestId('footer-shortcuts')).toHaveCount(0)
  await composer.expectFrom('seed@attn.test')
  const showCopies = page.getByTestId('composer-show-copies')
  await expect(showCopies).toBeVisible()
  await expect(showCopies).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('composer-discard')).toHaveAccessibleName('Discard draft')
  await expect(page.getByTestId('composer-discard')).toHaveAttribute('data-tooltip', /Discard draft \(.+⇧D\)/)
  await expect(page.getByTestId('composer-attach')).toHaveAttribute('data-tooltip', /Attach files \(.+⇧A\)/)

  const toInput = composer.recipientField().locator('input')
  await expect.poll(() => toInput.evaluate((input) => document.activeElement === input)).toBe(true)

  const formattingToolbar = page.getByRole('toolbar', { name: 'Formatting toolbar' })
  await expect(formattingToolbar).toHaveCount(0)
  await page.getByTestId('composer-format-toggle').click()
  await expect(formattingToolbar).toBeVisible()
  await expect
    .poll(() => formattingToolbar.evaluate((toolbar) => getComputedStyle(toolbar).flexWrap))
    .toBe('wrap')
  await page.getByTestId('composer-format-more').click()
  await expect(page.getByTestId('composer-format-menu')).toBeVisible()
  await expect(page.getByTestId('composer-format-menu')).toContainText('Strikethrough')
  await expect(page.getByTestId('composer-format-menu')).toContainText('Bulleted list')
  const formattingArtifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(formattingArtifactDirectory, { recursive: true })
  const formattingPath = join(formattingArtifactDirectory, 'composer-formatting.png')
  await page.screenshot({ path: formattingPath })
  await testInfo.attach('composer formatting', { path: formattingPath, contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-format-menu')).toHaveCount(0)
  await expect(composer.root).toBeVisible()

  await toInput.fill('may')
  await expect(page.getByTestId('autocomplete-option').first()).toContainText('Maya Lin')
  await toInput.press('Tab')
  await composer.expectRecipients(['maya@example.com'])

  await composer.addRecipient('not-an-address')
  await expect(toInput).toHaveAttribute('aria-invalid', 'true')
  await expect(composer.chips()).toHaveCount(1)
  await toInput.fill('')

  expect(await page.evaluate(() => window.attn.contacts.search('support'))).toEqual([])
  await toInput.fill('support')
  await expect(page.getByTestId('autocomplete-option')).toHaveCount(0)
  await toInput.press('Enter')
  await expect(toInput).toHaveAttribute('aria-invalid', 'true')
  await toInput.fill('')

  await composer.subject.fill('A calmer inbox')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+b')
  await composer.typeBody('Focused work deserves focused mail.')
  await page.keyboard.press('ControlOrMeta+b')

  // Text-entry keys belong to Lexical; they must never leak into list navigation or triage.
  const before = await selectedIndex(page)
  await composer.typeBody(' jke')
  await pasteVisiblePng(composer)
  expect(await selectedIndex(page)).toBe(before)
  await expect(page.getByTestId('thread-row')).toHaveCount(8)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer.png')
  await page.screenshot({ path })
  await testInfo.attach('composer', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  expect(await selectedIndex(page)).toBe(before)
  await expect(page.getByTestId('toast')).toContainText('Draft saved')
  await composer.expectPending(0)

  // `c` always creates a distinct draft; every older draft remains reachable.
  await composer.openNew()
  await composer.expectRecipients([])
  await expect(composer.subject).toHaveValue('')
  await composer.subject.fill('Second distinct draft')
  await page.keyboard.press('Escape')
  await goToDrafts(page)
  await expect(page.getByTestId('draft-row')).toHaveCount(2)
  await page.getByTestId('draft-row').filter({ hasText: 'A calmer inbox' }).click()
  await composer.expectRecipients(['maya@example.com'])
  await expect(composer.subject).toHaveValue('A calmer inbox')
  await expect(composer.editor).toContainText('Focused work deserves focused mail. jke')
  await expect(composer.editor.locator('img')).toHaveCount(1)
  expect(
    await page.evaluate(async () => {
      const draft = (await window.attn.draft.list()).find(
        (candidate) => candidate.subject === 'A calmer inbox'
      )
      return draft?.bodyHtml ?? ''
    })
  ).toContain('src="cid:')
  await showCopies.click()
  await expect(composer.recipientField('cc')).toBeVisible()
  await expect(composer.recipientField('bcc')).toBeVisible()
})

test('strikes text through with the format menu action (B10)', async ({ page }) => {
  // Lexical renders strikethrough purely through its theme class, so a missing
  // `.app-composer-strikethrough` rule left the toolbar action invisible while
  // the sent mail still carried <s>.
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Struck through')
  await composer.editor.locator('p').first().selectText()

  await page.getByTestId('composer-format-more').click()
  await page.getByTestId('composer-format-menu').getByText('Strikethrough').click()
  await expect(page.getByTestId('composer-format-menu')).toHaveCount(0)

  await expect
    .poll(() =>
      composer.editor.evaluate((root) =>
        [...root.querySelectorAll('*')].some((node) =>
          getComputedStyle(node).textDecorationLine.includes('line-through')
        )
      )
    )
    .toBe(true)
})

test('adds links from the toolbar and the registered composer shortcut', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Visit Attn')
  await composer.editor.locator('p').first().selectText()

  await page.getByTestId('composer-link').click()
  await page.getByTestId('composer-link-url').fill('attn.test')
  await page.getByTestId('composer-link-url').press('Enter')
  const link = composer.editor.locator('a').first()
  await expect(link).toHaveAttribute('href', 'https://attn.test')

  // Applying a link leaves its text selected so it can still be formatted.
  // Collapse that selection before exercising an ordinary link click.
  await page.keyboard.press('ArrowRight')
  await page.evaluate(() => {
    window.open = (url, target) => {
      document.body.dataset.openedComposerLink = String(url)
      document.body.dataset.openedComposerLinkTarget = String(target)
      return null
    }
  })
  await link.click()
  await expect
    .poll(() =>
      page.evaluate(() => ({
        target: document.body.dataset.openedComposerLinkTarget,
        url: document.body.dataset.openedComposerLink
      }))
    )
    .toEqual({ target: '_blank', url: 'https://attn.test' })
  await expect(composer.root).toBeVisible()

  await page.keyboard.press('ControlOrMeta+Shift+k')
  await expect(page.getByTestId('composer-link-popover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-link-popover')).toHaveCount(0)
  await expect(composer.root).toBeVisible()
})

test('preserves comma names and pending recipients while keeping cleanly closed drafts closed', async ({
  boot,
  page
}) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  let input = composer.recipientField().locator('input')

  await input.fill('doe')
  await expect(page.getByTestId('autocomplete-option').first()).toContainText('Doe, John')
  await input.press('Tab')
  await composer.expectRecipients(['john.doe@example.com'])

  // Escape must commit valid text that has not yet become a chip.
  await input.fill('pending@example.com')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: '(no subject)' }).click()
  await composer.expectRecipients(['john.doe@example.com', 'pending@example.com'])

  // Invalid pending text keeps the composer open instead of being silently lost.
  input = composer.recipientField().locator('input')
  await input.fill('not-an-address')
  await page.keyboard.press('Escape')
  await expect(composer.root).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill('')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  // A deliberate save-and-close is discoverable in Drafts, but is not crash recovery.
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toHaveCount(0)
  await goToDrafts(page)
  await page.getByTestId('draft-row').click()
  await composer.expectRecipients(['john.doe@example.com', 'pending@example.com'])
})

test('discards an empty draft on close', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Empty draft discarded')
  await goToDrafts(page)
  await expect(page.getByTestId('draft-row')).toHaveCount(0)
})

test('discards a draft with Mod+Shift+D from the composer and Drafts list', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Discard from composer')
  await page.keyboard.press('ControlOrMeta+Shift+d')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Draft discarded')

  await composer.openNew()
  await composer.subject.fill('Keep in Drafts')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await composer.openNew()
  await composer.subject.fill('Discard from Drafts')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await goToDrafts(page)

  const rows = page.getByTestId('draft-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await expect(rows.first()).toContainText('Discard from Drafts')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-input').fill('Discard draft')
  await expect(page.locator('[data-command-id="draft.discard"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+d')
  await expect(page.getByTestId('toast')).toContainText('Draft discarded')

  await expect(rows).toHaveCount(1)
  await expect(rows).not.toContainText('Discard from Drafts')
  await expect(rows.first()).toContainText('Keep in Drafts')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
})

test('keeps pending inline recipients when collapsing the envelope', async ({ page }) => {
  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  const composer = new ComposerPage(page)
  await composer.openReply()
  await page.getByTestId('composer-show-copies').click()
  const summary = page.getByTestId('composer-recipient-summary')
  for (const field of ['to', 'cc', 'bcc']) {
    const input = page.getByTestId(`composer-${field}`).locator('input')
    await input.fill('unfinished@')
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(input).toHaveValue('unfinished@')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await input.fill(`${field}@example.com`)
    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await summary.click()
    await expect(page.getByTestId(`composer-${field}`).getByTestId('recipient-chip')).toContainText([
      `${field}@example.com`
    ])
    await expect(input).toHaveValue('')
  }
})

test('opens reply, reply-all, and forward drafts from the reader and reuses the reply draft', async ({
  page
}, testInfo) => {
  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  const oldestMessage = page.getByTestId('message-card').first()
  await oldestMessage.evaluate((element) => element.style.setProperty('min-height', '4000px'))
  const composer = new ComposerPage(page)
  await composer.openReply()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'reply')
  await expect(composer.root).toHaveAttribute('data-composer-mode', 'inline')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-content').getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('conversation-back')).toHaveCount(0)
  await composer.expectRecipients(['maya+roadmap@example.com'])
  await expect
    .poll(async () => {
      const [viewport, draft] = await Promise.all([
        page.getByTestId('conversation-scroll').boundingBox(),
        composer.root.boundingBox()
      ])
      return viewport !== null && draft !== null && draft.y + draft.height <= viewport.y + viewport.height + 1
    })
    .toBe(true)
  await oldestMessage.evaluate((element) => element.style.removeProperty('min-height'))
  const quoteToggle = page.getByTestId('composer-quote-toggle')
  await expect(quoteToggle).toHaveText('...')
  await expect(quoteToggle).toHaveAttribute('aria-expanded', 'false')
  await quoteToggle.click()
  const quoteFrame = page.getByTestId('composer-quote')
  await expect(quoteFrame).toHaveAttribute('data-surface', 'native')
  await expect(quoteFrame).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.frameLocator('[data-testid="composer-quote"]').locator('body')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  )
  expect(await quoteToggle.evaluate((element) => element.closest('details'))).toBeNull()
  await composer.typeBody('Keep this authored reply')
  await expect(composer.editor).toContainText('Keep this authored reply')
  await composer.expectSaved()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'inline-reply.png')
  await page.screenshot({ path })
  await testInfo.attach('inline-reply', { path, contentType: 'image/png' })
  const replyId = await composer.root.getAttribute('data-draft-id')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(
    page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).getByTestId('chip-draft')
  ).toBeVisible()

  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  await composer.root.waitFor()
  await expect(composer.root).toHaveAttribute('data-draft-id', replyId ?? '')
  await expect(composer.editor).toContainText('Keep this authored reply')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  await page.keyboard.press('Enter')
  await composer.root.waitFor()
  await expect(composer.root).toHaveAttribute('data-draft-id', replyId ?? '')
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'replyAll')
  await composer.expectRecipients(['maya+roadmap@example.com', 'priya@example.com'])
  await composer.expectRecipients(['daniel@example.com'], 'cc')
  await expect(composer.editor).toContainText('Keep this authored reply')
  await page.getByTestId('composer-discard').click()
  await expect(composer.root).toHaveCount(0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  await page.keyboard.press('f')
  await composer.root.waitFor()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await expect(composer.root).toHaveAttribute('data-composer-mode', 'inline')
  await composer.expectRecipients([])
  await expect(page.getByTestId('composer-quote-toggle')).toBeVisible()
  await composer.typeBody('Forward this roadmap context')
  await composer.expectSaved()
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('conversation-back').click()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await expect(composer.editor).toContainText('Forward this roadmap context')
})

test('releases a delayed draft reopen when the reader closes first', async ({ app, page }) => {
  const thread = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await thread.click()
  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.typeBody('Keep this delayed reply')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(thread.getByTestId('chip-draft')).toBeVisible()

  await app.evaluate(({ ipcMain }, args) => ipcMain.emit(args.channel, {}, args.delayMs), {
    channel: TEST_CHANNELS.delayDraftReopen,
    delayMs: 400
  })
  await thread.click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect
    .poll(() => page.evaluate(async () => (await window.attn.draft.takeRecovered())?.id ?? null))
    .toBeNull()

  await app.evaluate(({ ipcMain }, args) => ipcMain.emit(args.channel, {}, args.delayMs), {
    channel: TEST_CHANNELS.delayDraftReopen,
    delayMs: 0
  })
  await thread.click()
  await expect(composer.root).toContainText('Keep this delayed reply')
})

test('keeps a detached draft escapable when its parent thread is missing', async ({ app, page }) => {
  const thread = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await thread.click()
  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.typeBody('Detached reply body')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')

  const deleteError = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.threadId, resolve)),
    {
      channel: TEST_CHANNELS.deleteThread,
      threadId: 't-design'
    }
  )
  if (deleteError) throw new Error(deleteError)
  await goToDrafts(page)
  const draft = page.getByTestId('draft-row').filter({ hasText: 'Design notes' })
  await draft.click()
  await expect(composer.root).toBeVisible()
  await expect(composer.root).toContainText('Detached reply body')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('draft-list')).toBeVisible()

  await draft.click()
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('j')
  await expect(page.getByTestId('draft-list')).toBeVisible()
})

test('uses one control for the signature and quote, then discards an untouched reply', async ({
  app,
  page
}, testInfo) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await expect(composer.root).toBeVisible()
  await composer.expectSignatureAndQuoteCollapsed()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer-signature-quote-collapsed.png')
  await page.screenshot({ path })
  await testInfo.attach('composer-signature-quote-collapsed', { path, contentType: 'image/png' })

  await composer.revealSignature()
  await expect(composer.signature).toContainText('Chao Wu')
  await expect(composer.quote).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()

  // The quote, planned recipients and "Re:" subject are ours, not the user's,
  // so an unedited reply leaves nothing behind — as Gmail does.
  await expect(design.getByTestId('chip-draft')).toHaveCount(0)
  await goToDrafts(page)
  await expect(page.getByTestId('draft-row').filter({ hasText: 'Design notes' })).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByTestId('thread-list')).toBeVisible()

  // One keystroke of the user's own is enough to make it worth keeping.
  await design.click()
  await composer.openReply()
  await composer.typeBody('Worth keeping')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(design.getByTestId('chip-draft')).toBeVisible()
})

test('body undo and select-all stay inside authored text above the signature and quote', async ({
  app,
  page
}) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  await page.getByTestId('thread-row').filter({ hasText: 'Design notes' }).click()
  await composer.openReply()
  await composer.editor.click({ position: { x: 42, y: 18 } })

  await page.keyboard.type('Undo this whole edit')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(composer.editor).not.toContainText('Undo this whole edit')

  await page.keyboard.type('Select only this new reply')
  await expect(page.getByTestId('composer-attn-signature')).not.toContainText('Select only this new reply')
  await expect(composer.editor.locator(':scope > *').first()).toContainText('Select only this new reply')
  await page.keyboard.press('ControlOrMeta+a')
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected).toContain('Select only this new reply')
  expect(selected).not.toContain('Chao Wu')
  expect(selected).not.toContain('Sent with Attn')
  expect(selected).not.toContain('conversation overlay direction')

  await page.keyboard.press('Backspace')
  await expect(composer.editor).not.toContainText('Select only this new reply')
  await expect(composer.signature).toContainText('Chao Wu')
  await expect(page.getByTestId('composer-attn-signature')).toContainText('Sent with Attn')

  // Deleting the whole authored selection must leave an editable paragraph
  // before the protected signature instead of parking the caret inside it.
  await page.keyboard.type('Starting this reply over')
  await expect(composer.editor).toContainText('Starting this reply over')
  await expect(composer.signature).not.toContainText('Starting this reply over')
  await expect(composer.editor.locator(':scope > *').first()).toContainText('Starting this reply over')

  await composer.revealSignature()
  await expect(composer.quote).toBeVisible()
})

test('keeps the signature discardable when a reply becomes reply-all', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'reply')
  await page.getByTestId('composer-discard').click()
  await expect(composer.root).toHaveCount(0)

  // Reply-All re-plans the recipients on our side; that is not the user
  // contributing content, so the draft stays discardable.
  await page.keyboard.press('a')
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'replyAll')
  await composer.expectSignatureAndQuoteCollapsed()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(design.getByTestId('chip-draft')).toHaveCount(0)
})

test('keeps the view nav and sync footer while an inline draft is open', async ({ page }) => {
  const composer = new ComposerPage(page)
  await expect(page.getByTestId('thread-row').first()).toHaveAttribute('data-selected', 'true')

  await page.keyboard.press('r')
  await expect(composer.root).toBeVisible()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  // An inline composer leaves the list and reader on screen, so the app chrome
  // stays with them; only the footer's shortcut hints follow the keyboard owner.
  await expect(page.getByTestId('sidebar-mailbox').filter({ hasText: 'Inbox' })).toHaveAttribute(
    'data-active',
    'true'
  )
  await expect(page.getByTestId('mail-footer')).toBeVisible()
  await expect(page.getByTestId('footer-shortcut-send')).toBeVisible()
  await expect(page.getByTestId('footer-shortcut-done')).toHaveCount(0)

  await page.getByTestId('composer-discard').click()
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()

  // A full-window new-mail composer still owns the whole window.
  await composer.openNew()
  await expect(page.getByTestId('view-title')).toHaveCount(0)
  await expect(page.getByTestId('mail-footer')).toHaveCount(0)
})

test('saves an inline reply before switching to Drafts from the sidebar', async ({ page }) => {
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await composer.typeBody('Saved through header navigation')

  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Drafts' }).click()
  await expect(page.getByTestId('draft-list')).toBeVisible()
  await page.getByTestId('draft-row').filter({ hasText: 'Design notes' }).click()
  await expect(composer.editor).toContainText('Saved through header navigation')
})

test('restores a bound draft when J reads into its conversation', async ({ page }) => {
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await composer.typeBody('Restored by keyboard navigation')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(design.getByTestId('chip-draft')).toBeVisible()
  await expect.poll(() => selectedIndex(page)).toBe(2)

  await page.keyboard.press('k')
  await expect.poll(() => selectedIndex(page)).toBe(1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(composer.root).toHaveCount(0)

  // SPEC §5: J opens the next conversation at its newest message *or restored
  // draft*, so reading into a Draft-chipped row matches clicking it.
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(2)
  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText('Restored by keyboard navigation')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
})

test('releases a superseded reopen lease when J leaves before it resolves', async ({ app, page }) => {
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await composer.typeBody('Lease released by navigation')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(design.getByTestId('chip-draft')).toBeVisible()

  await app.evaluate(({ ipcMain }, args) => ipcMain.emit(args.channel, {}, args.delayMs), {
    channel: TEST_CHANNELS.delayDraftReopen,
    delayMs: 400
  })
  await design.click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  // J moves the selection without bumping the reopen counter, so the in-flight
  // reopen still has to release the row `draft:reopen` already set composing.
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(3)
  await expect(composer.root).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await window.attn.draft.takeRecovered())?.id ?? null))
    .toBeNull()
})

test('marks and opens a Gmail forward draft inline when its parent thread is cached', async ({
  app,
  page
}, testInfo) => {
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteForwardDraft(
        'gmail-thread-forward',
        't-design',
        'Fwd: Design notes',
        '<p>Forward this design context</p>'
      )
    }
  )
  if (error) throw new Error(error)

  const thread = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await expect(thread.getByTestId('chip-draft')).toBeVisible()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'draft-chip.png')
  await page.screenshot({ path })
  await testInfo.attach('draft-chip', { path, contentType: 'image/png' })
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Fwd: Design notes' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-composer-mode', 'inline')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await expect(page.getByTestId('conversation-back')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('conversation-back')).toHaveAttribute('aria-label', 'Back to Drafts')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('draft-list')).toBeVisible()
  await expect(page.getByTestId('view-title')).toHaveText('Drafts')
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await thread.click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await page.getByTestId('composer-close').click()
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await page.getByTestId('conversation-back').click()
  const archivedError = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteForwardDraft(
        'gmail-archived-forward',
        't-sent-history',
        'Fwd: Re: Q3 roadmap review',
        '<p>Forward this archived context</p>'
      )
    }
  )
  if (archivedError) throw new Error(archivedError)

  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Fwd: Re: Q3 roadmap review' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Re: Q3 roadmap review')
  await expect(page.getByTestId('message-card')).toContainText('Thanks — I added my notes.')
  await expect(page.getByTestId('conversation-back')).toHaveCount(0)
  await expect(page.getByTestId('composer')).toHaveAttribute('data-composer-mode', 'inline')
})

test('preserves a newsletter surface and CID resources in a forward draft', async ({ page }, testInfo) => {
  await page.getByTestId('thread-subject').getByText('This week in focus', { exact: true }).click()
  await page.keyboard.press('f')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await page.getByTestId('composer-quote-toggle').click()
  const quoteFrame = page.getByTestId('composer-quote')
  await expect(quoteFrame).toHaveAttribute('data-surface', 'light')
  await expect(quoteFrame).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  const quoteBody = page.frameLocator('[data-testid="composer-quote"]')
  await expect(quoteBody.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(
    quoteBody.locator('table').filter({ hasText: 'You completed twelve focused conversations.' })
  ).toHaveCSS('background-color', 'rgb(255, 243, 214)')
  await expect(quoteBody.locator('img[src]').first()).toHaveAttribute('src', /^data:image\/gif;base64,/)
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'newsletter-quote.png')
  await page.screenshot({ path })
  await testInfo.attach('newsletter quote', { path, contentType: 'image/png' })
  const attachment = await page.evaluate(async () => {
    const id = document.querySelector<HTMLElement>('[data-testid="composer"]')?.dataset.draftId
    const draft = id ? await window.attn.draft.get(id) : null
    return draft?.attachments.find((candidate) => candidate.contentId === 'weekly-image@attn.test') ?? null
  })
  expect(attachment).toMatchObject({ inline: true, contentId: 'weekly-image@attn.test' })
  expect(attachment).not.toHaveProperty('spoolPath')

  const composer = new ComposerPage(page)
  await composer.editor.click()
  await composer.typeBody('Sharing this long read.')
  await composer.expectSaved()
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('conversation-back').click()
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await page.getByTestId('thread-subject').getByText('This week in focus', { exact: true }).click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'forward')
  await page.getByTestId('html-body-frame').evaluate((element) => {
    const iframe = element as HTMLIFrameElement
    const marker = iframe.contentDocument?.querySelector('[data-attn-trim-start]')
    const spacer = iframe.contentDocument?.createElement('div')
    if (!marker || !spacer) throw new Error('mail trim marker unavailable')
    spacer.style.height = '2000px'
    marker.before(spacer)
  })
  await expect
    .poll(() => page.getByTestId('html-body-frame').evaluate((element) => element.clientHeight))
    .toBeGreaterThan(2_000)
  await expect(page.getByTestId('composer-inline-header')).toBeInViewport()
  await expect(page.getByTestId('composer-footer')).toBeInViewport()
  expect(
    await page.evaluate(() => {
      const rootRect = document.getElementById('root')?.getBoundingClientRect()
      return (
        document.scrollingElement?.scrollTop === 0 &&
        rootRect !== undefined &&
        Math.abs(rootRect.top) < 1 &&
        Math.abs(rootRect.bottom - window.innerHeight) < 1
      )
    })
  ).toBe(true)
})

test('preserves rich and opaque draft regions while editing elsewhere', async ({ page }) => {
  const richHtml =
    '<p style="color:#c00">Coloured intro</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline" style="width:42px; border:3px solid rgb(1, 2, 3)"><table><tbody><tr><td>Keep cell</td></tr></tbody></table><section data-layout="card"><mark>Opaque exact region</mark></section>'
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.evaluate(async (bodyHtml) => {
    const { id } = await window.attn.draft.save({
      ...({
        id: null,
        kind: 'new',
        to: [{ name: '', email: 'rich@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Rich draft',
        bodyHtml,
        bodyText: 'Coloured intro\nKeep cell\nOpaque exact region',
        attachments: [],
        threadId: null,
        sourceMessageId: null,
        inReplyTo: null,
        references: [],
        quoteHtml: '',
        quoteText: '',
        followUpAt: null
      } as const)
    })
    await window.attn.draft.close(id)
  }, richHtml)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Rich draft' }).click()
  const composer = new ComposerPage(page)
  await expect(composer.editor.locator('table')).toContainText('Keep cell')
  await expect(composer.editor.locator('img')).toHaveCount(1)
  await expect(composer.editor.locator('img')).toHaveCSS('width', '42px')
  await expect(page.getByTestId('composer-preserved-banner')).toBeVisible()
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await composer.typeBody(' Added outside.')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  const savedHtml = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((candidate) => candidate.subject === 'Rich draft')
    return draft?.bodyHtml ?? ''
  })
  expect(savedHtml).toContain('<table>')
  expect(savedHtml).toMatch(/color: (?:#c00|rgb\(204, 0, 0\))/)
  expect(savedHtml).toContain('<section data-layout="card"><mark>Opaque exact region</mark></section>')
})

test('pastes Notes paragraphs as editable text and preserves them through reopening', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Notes paste')
  await composer.editor.click()
  // Native Cocoa HTML export captured from Notes, with the text anonymized.
  await pasteHtml(composer, readFileSync(join(__dirname, 'fixtures/notes-clipboard.html.txt'), 'utf8'))
  await expect(composer.editor).toContainText('Hello Jordan,')
  await expect(composer.editor.locator('iframe')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  const greeting = composer.editor.locator('p').filter({ hasText: 'Hello Jordan,' })
  await greeting.click()
  await page.keyboard.type('Editable ')
  await expect(greeting).toContainText('Editable ')
  await expect(composer.editor).toContainText('Thanks again,')
  await expect(composer.editor).toContainText('Taylor')
  await composer.expectSaved()
  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`${colorScheme}$`))
    await page.screenshot({ path: join(__dirname, `.artifacts/notes-paste-${colorScheme}.png`) })
  }
  await page.keyboard.press('Escape')
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Notes paste' }).click()
  await expect(composer.editor).toContainText('Editable ')
  await expect(composer.editor.locator('iframe')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'Notes paste')
    return draft ? await window.attn.draft.get(draft.id) : null
  })
  expect(saved?.bodyText).toContain('Thank you for the conversation.')
  expect(saved?.bodyText).toContain('Thanks again,')
  expect(saved?.bodyHtml).not.toContain('data-attn-opaque')
})

test('Notes emphasis stays editable with the formatting controls', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Notes formatting')
  await composer.editor.locator('p').first().click()
  await pasteHtml(
    composer,
    `<meta name="Generator" content="Cocoa HTML Writer">
    <style>p.p1 {font: 13px Helvetica} span.s1 {font-weight: bold}
    span.s2 {text-decoration: underline} span.s3 {font-style: italic}</style>
    <p class="p1"><b>Bold sample</b></p>
    <p class="p1"><span class="s2">Underline sample</span></p>
    <p class="p1"><span class="s3">Italic sample</span></p>
    <p class="p1">Plain sample</p>`
  )
  const bold = composer.editor.getByText('Bold sample', { exact: true })
  const underline = composer.editor.getByText('Underline sample', { exact: true })
  const italic = composer.editor.getByText('Italic sample', { exact: true })
  const plain = composer.editor.getByText('Plain sample', { exact: true })
  await expect(bold).toHaveCSS('font-weight', '700')
  await expect(underline).toHaveCSS('text-decoration-line', 'underline')
  await expect(italic).toHaveCSS('font-style', 'italic')
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await bold.selectText()
  await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(bold).toHaveCSS('font-weight', '400')
  await plain.selectText()
  await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(plain).toHaveCSS('font-weight', '700')
  await plain.selectText()
  await page.getByRole('button', { name: 'Underline', exact: true }).click()
  await expect(plain).toHaveCSS('text-decoration-line', 'underline')
  await composer.expectSaved()
  await page.keyboard.press('ArrowRight')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`${colorScheme}$`))
    await page.screenshot({ path: join(__dirname, `.artifacts/notes-formatting-${colorScheme}.png`) })
  }
})

for (const source of ['docs', 'notion'] as const) {
  test(`pastes editable ${source} structure and saves it through reopening`, async ({ page }) => {
    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.subject.fill(`${source} rich paste`)
    await composer.editor.locator('p').first().click()
    await pasteHtml(composer, readFileSync(join(__dirname, `fixtures/${source}-clipboard.html.txt`), 'utf8'))
    await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
    await expect(composer.editor.locator('iframe')).toHaveCount(0)
    if (source === 'docs') {
      await expect(composer.editor.getByText('Bold words', { exact: true })).toHaveCSS('font-weight', '700')
      await expect(composer.editor.getByText('Highlighted words', { exact: true })).toHaveCSS(
        'background-color',
        'rgb(255, 240, 120)'
      )
      await expect(composer.editor.locator('table')).toHaveCount(1)
      await expect(composer.editor.locator('ol')).toHaveAttribute('start', '3')
    } else {
      await expect(composer.editor).toContainText('☑ Done')
      await expect(composer.editor).toContainText('☐ Next task')
      await expect(composer.editor).toContainText('Expanded text')
      await expect(composer.editor.getByText('first line', { exact: true })).toHaveCSS(
        'font-family',
        'monospace'
      )
      await expect(composer.editor.getByText('indented line', { exact: true })).toHaveCSS(
        'font-family',
        'monospace'
      )
      await expect(composer.editor.getByRole('link', { name: 'Demo' })).toHaveAttribute(
        'href',
        'https://example.com/demo'
      )
    }
    await composer.expectSaved()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`${colorScheme}$`))
      await page.screenshot({ path: join(__dirname, `.artifacts/${source}-paste-${colorScheme}.png`) })
    }
    await page.keyboard.press('Escape')
    await goToDrafts(page)
    await page
      .getByTestId('draft-row')
      .filter({ hasText: `${source} rich paste` })
      .click()
    await expect(composer.editor.locator('iframe')).toHaveCount(0)
    await expect(composer.editor).toContainText(source === 'docs' ? 'Fourth item' : 'Expanded text')
  })
}

test('pastes without formatting and clears selected formatting through commands', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Plain paste')
  await composer.editor.locator('p').first().click()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'Plain clipboard\nSecond line' }
    })
  })
  await page.keyboard.press('ControlOrMeta+Shift+v')
  await expect(composer.editor).toContainText('Plain clipboard')
  await expect(composer.editor).toContainText('Second line')
  await runPaletteCommand(page, 'Paste without formatting')
  await expect(composer.editor).toContainText('Second linePlain clipboard')
  await composer.editor.locator('p').first().click()
  await pasteHtml(
    composer,
    '<p><span style="font-weight:bold;color:red;background-color:yellow">Clear this</span></p>'
  )
  const text = composer.editor.getByText('Clear this', { exact: true })
  await expect(text).toHaveCSS('font-weight', '700')
  await text.selectText()
  await runPaletteCommand(page, 'Clear formatting')
  await expect(text).toHaveCSS('font-weight', '400')
  await expect(text).not.toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(text).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await runPaletteCommand(page, 'Undo body text')
  await expect(text).toHaveCSS('font-weight', '700')
  await expect(text).toHaveCSS('color', 'rgb(255, 0, 0)')
  await composer.expectSaved()
})

test('plain paste inherits styled caret formatting across lines', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.locator('p').first().click()
  await pasteHtml(composer, '<p><span style="font-weight:bold;color:red;font-family:Georgia">Seed</span></p>')
  await composer.editor.getByText('Seed', { exact: true }).evaluate((element) => {
    const range = document.createRange()
    if (!element.firstChild) throw new Error('Missing styled text')
    range.setStart(element.firstChild, 3)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.type('X')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'Styled\nNext' }
    })
  })
  await page.keyboard.press('ControlOrMeta+Shift+v')
  const next = composer.editor.getByText('Next', { exact: true })
  await expect(next).toHaveCSS('font-weight', '700')
  await expect(next).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(next).toHaveCSS('font-family', 'Georgia')
})

test('clearing a collapsed caret keeps the existing link intact', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.locator('p').first().click()
  await pasteHtml(composer, '<p><a href="https://example.com">Reference</a></p>')
  const link = composer.editor.getByRole('link', { name: 'Reference', exact: true })
  await link.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text) throw new Error('Missing link text')
    const range = document.createRange()
    range.setStart(text, 3)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await page.keyboard.type('X')
  await runPaletteCommand(page, 'Clear formatting')
  await expect(composer.editor.getByRole('link', { name: 'RefXerence', exact: true })).toHaveAttribute(
    'href',
    'https://example.com'
  )
})

test('plain paste leaves recipient and subject shortcuts native', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.locator('p').first().click()
  await page.keyboard.type('Existing body')
  await page.getByRole('button', { name: 'Show Cc and Bcc fields' }).click()
  for (const input of [
    composer.subject,
    ...(['to', 'cc', 'bcc'] as const).map((field) => composer.recipientField(field).locator('input'))
  ]) {
    await input.focus()
    const native = await input.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'V',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    expect(native).toBe(true)
  }
  await expect(composer.editor).toContainText('Existing body')
})

test('preserves unsupported foreign HTML pasted into a new draft', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Pasted opaque HTML')
  await composer.editor.click()
  const opaque = '<aside data-layout="callout"><mark>Pasted exact region</mark></aside>'
  await pasteHtml(composer, opaque)
  await expect(page.getByTestId('composer-preserved-banner')).toBeVisible()
  await expect(composer.editor.locator('iframe[title="Preserved draft content"]')).toHaveCount(1)
  await composer.expectSaved()
  await page.keyboard.press('Escape')

  const savedHtml = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find(
      (candidate) => candidate.subject === 'Pasted opaque HTML'
    )
    return draft?.bodyHtml ?? ''
  })
  expect(savedHtml).toContain(opaque)
})

test('a preserved region in a reply registers its preview frame under the source message', async ({
  page
}) => {
  // T33 (PR #101 review): the opaque preview renders the same untrusted mail
  // HTML as the quoted history, so a reply's preserved content joins main's
  // remote-image filter under the replied-to message — the mounted frame
  // carries its registration nonce as its name, which is what per-sender
  // exceptions key on. A draft with no source message stays unnamed and
  // fails closed (asserted in the Gmail-import test below).
  await page.getByTestId('thread-row').filter({ hasText: 'Design notes' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.editor.click()
  await pasteHtml(composer, '<aside data-layout="callout"><mark>Preserved reply region</mark></aside>')
  const frame = composer.editor.locator('iframe[title="Preserved draft content"]')
  await expect(frame).toHaveCount(1)
  await expect(frame).toHaveAttribute('name', /^[0-9a-f-]{36}$/)
})

test('spools data images pasted through HTML and saves them as CID parts', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('HTML data image')
  await composer.editor.click()
  await pasteHtml(
    composer,
    '<p>Before</p><img alt="pixel.png" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"><p>After</p>'
  )
  // A pasted image lives in the body, not the attachment row: it has no chip to
  // remove, so counting it as an attachment would advertise something unusable.
  await expect(composer.editor.locator('img')).toHaveCount(1)
  await expect(composer.attachments).toHaveCount(0)
  await expect(page.getByTestId('composer-attachment-chip')).toHaveCount(0)
  await composer.expectSaved()
  await page.keyboard.press('Escape')

  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find(
      (candidate) => candidate.subject === 'HTML data image'
    )
    return draft ? { html: draft.bodyHtml, attachments: draft.attachments } : null
  })
  expect(saved?.html).toContain('src="cid:')
  expect(saved?.attachments).toHaveLength(1)
})

test('rejects a stale discard without deleting a closed draft image', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Keep closed image')
  await pasteVisiblePng(composer)
  await composer.expectSaved()
  const draftId = await composer.root.getAttribute('data-draft-id')
  if (!draftId) throw new Error('missing draft id')
  const contentId = await page.evaluate(async (id) => {
    const draft = await window.attn.draft.get(id)
    return draft?.attachments[0]?.contentId ?? null
  }, draftId)
  if (!contentId) throw new Error('missing inline image content id')
  await page.keyboard.press('Escape')

  const staleDiscardError = await page.evaluate(async (id) => {
    try {
      await window.attn.draft.discard(id)
      return ''
    } catch (error) {
      return String(error)
    }
  }, draftId)
  expect(staleDiscardError).toContain('draft is unavailable')

  const image = await page.evaluate(
    async ({ id, cid }) => {
      await window.attn.draft.reopen(id)
      return window.attn.draft.getInlineImage(id, cid)
    },
    { id: draftId, cid: contentId }
  )
  expect(image).toHaveProperty('dataUrl')
  expect('dataUrl' in image ? image.dataUrl : '').toMatch(/^data:image\/png;base64,/)
})

test('hydrates Gmail CID images and imports its signature as editable composer content', async ({
  app,
  page
}, testInfo) => {
  const gmailHtml =
    '<div dir="ltr"><div>Draft from Gmail</div><div><img data-surl="cid:remote-inline" src="cid:remote-inline" alt="Gmail inline image" width="180"></div><div><br></div><div><div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr"><div>Best,</div><div>Chao Wu</div><div><a href="https://chaowu.xyz" target="_blank">https://chaowu.xyz</a></div></div></div></div>'
  const inlineImageBase64 = await visiblePngBase64(page)
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-signature',
        'Gmail image and signature',
        gmailHtml,
        '',
        true,
        inlineImageBase64
      )
    }
  )
  if (error) throw new Error(error)

  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Gmail image and signature' }).click()
  const composer = new ComposerPage(page)
  await expect(composer.editor.locator('img[alt="Gmail inline image"]')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  )
  const signature = composer.signature
  await expect(signature).toHaveCount(1)
  expect(
    await signature.evaluate((element) => {
      const previous = element.previousElementSibling
      return previous?.tagName === 'P' && !previous.textContent?.trim()
    })
  ).toBe(true)
  await composer.expectSignatureCollapsed()
  await expect(signature.getByText('Best,')).toBeHidden()
  await composer.revealSignature()
  await expect(signature.getByText('Best,')).toBeVisible()
  await expect(signature.getByText('Chao Wu')).toBeVisible()
  await expect(signature).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(composer.editor.locator('iframe[title="Preserved draft content"]')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)

  await signature.getByText('Chao Wu', { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' — edited')
  await expect(signature.getByText('Chao Wu — edited', { exact: true })).toBeVisible()
  await composer.expectSaved()

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'gmail-draft.png')
  await page.screenshot({ path })
  await testInfo.attach('gmail-draft', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  const savedHtml = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find(
      (candidate) => candidate.subject === 'Gmail image and signature'
    )
    return draft?.bodyHtml ?? ''
  })
  expect(savedHtml).toContain('data-surl="cid:remote-inline"')
  expect(savedHtml).not.toContain('<p')
  expect(savedHtml).toContain('<div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr">')
  expect(savedHtml).toContain('Chao Wu — edited')
})

test('groups the Gmail signature separator without changing its saved position or spacing', async ({
  app,
  page
}, testInfo) => {
  const gmailHtml =
    '<div dir="ltr"><div><br clear="all"></div><div>Draft from Gmail</div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div>Best,</div><div><font face="arial, sans-serif">Alex Rivera</font></div><div><a href="https://northstar.test/">Northstar</a></div></div></div>'
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft('gmail-signature-prefix', 'Gmail signature separator', gmailHtml)
    }
  )
  if (error) throw new Error(error)
  await page.emulateMedia({ colorScheme: 'light' })
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Gmail signature separator' }).click()
  const composer = new ComposerPage(page)
  const prefix = page.getByTestId('composer-gmail-signature-prefix')
  await composer.expectSignatureCollapsed()
  await expect(prefix).toHaveCount(1)
  await expect(prefix).toBeHidden()
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  await expect(composer.editor.locator('iframe')).toHaveCount(0)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const collapsedPath = join(dir, 'composer-signature-prefix-collapsed.png')
  await page.screenshot({ path: collapsedPath })
  await testInfo.attach('signature separator collapsed', { path: collapsedPath, contentType: 'image/png' })
  await composer.revealSignature()
  await expect(prefix).toBeVisible()
  await expect(prefix).toHaveText('-- ')
  await expect(composer.signature.getByText('Best,', { exact: true })).toBeVisible()
  expect(
    await prefix.evaluate((element) => {
      const next = element.nextElementSibling
      return next ? next.getBoundingClientRect().top - element.getBoundingClientRect().bottom : null
    })
  ).toBeCloseTo(0, 0)
  const expandedPath = join(dir, 'composer-signature-prefix-expanded.png')
  await page.screenshot({ path: expandedPath })
  await testInfo.attach('signature separator expanded', { path: expandedPath, contentType: 'image/png' })

  await composer.editor.getByText('Draft from Gmail', { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((row) => row.subject === 'Gmail signature separator')
    if (!draft) throw new Error('saved draft missing')
    const document = new DOMParser().parseFromString(draft.bodyHtml, 'text/html')
    const prefix = document.querySelector('.gmail_signature_prefix')
    const signature = document.querySelector('.gmail_signature')
    return {
      text: draft.bodyText,
      prefixText: prefix?.textContent,
      prefixStyle: prefix?.getAttribute('style'),
      prefixOutside: prefix?.parentElement === signature?.parentElement,
      singleLineBreak:
        prefix?.nextElementSibling?.tagName === 'BR' &&
        prefix.nextElementSibling.nextElementSibling === signature,
      prefixCount: document.querySelectorAll('.gmail_signature_prefix').length
    }
  })
  expect(saved.text).toContain('Draft from Gmail edited\n\n-- \nBest,\nAlex Rivera\nNorthstar')
  expect(saved).toMatchObject({
    prefixText: '-- ',
    prefixStyle: null,
    prefixOutside: true,
    singleLineBreak: true,
    prefixCount: 1
  })
  await page.getByTestId('draft-row').filter({ hasText: 'Gmail signature separator' }).click()
  await composer.expectSignatureCollapsed()
  await expect(prefix).toBeHidden()
  await expect(prefix).toHaveCount(1)
  await composer.revealSignature()
  await expect(prefix).toHaveText('-- ')
})

test('hydrates bracketed percent-encoded CID images inside preserved HTML', async ({ app, page }) => {
  const inlineImageBase64 = await visiblePngBase64(page)
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-opaque-cid',
        'Opaque CID image',
        '<section data-layout="card"><img src="cid:%3Cremote-inline%3E" alt="Opaque Gmail inline image"></section>',
        '',
        true,
        inlineImageBase64
      )
    }
  )
  if (error) throw new Error(error)

  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Opaque CID image' }).click()
  const composer = new ComposerPage(page)
  await expect(page.getByTestId('composer-preserved-banner')).toBeVisible()
  await expect(
    composer.editor
      .frameLocator('iframe[title="Preserved draft content"]')
      .locator('img[alt="Opaque Gmail inline image"]')
  ).toHaveAttribute('src', /^data:image\/png;base64,/)
  // No source message on a standalone Gmail draft: the preview frame stays
  // unnamed and fails closed while blocking is on (T33, PR #101 review).
  await expect(composer.editor.locator('iframe[title="Preserved draft content"]')).not.toHaveAttribute(
    'name',
    /.+/
  )
})

test('opens and edits a remote plain-text-only draft without losing its body', async ({ app, page }) => {
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remotePlainDraft('gmail-plain-1', 'Remote plain text', 'Keep the original plain body')
    }
  )
  if (error) throw new Error(error)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Remote plain text' }).click()
  const composer = new ComposerPage(page)
  await expect(composer.editor).toContainText('Keep the original plain body')
  const draftId = await composer.root.getAttribute('data-draft-id')
  if (!draftId) throw new Error('remote draft id missing')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await composer.typeBody(' plus a local edit')
  await composer.expectSaved()
  const composingDraft = await page.evaluate(async (id) => window.attn.draft.get(id), draftId)
  expect(composingDraft?.bodyText).toContain('Keep the original plain body plus a local edit')
  await page.keyboard.press('Escape')

  const body = await page.evaluate(
    async (id) => (await window.attn.draft.reopen(id))?.bodyText ?? '',
    draftId
  )
  expect(body).toContain('Keep the original plain body plus a local edit')
})

test('does not overwrite typing when CID image hydration finishes late', async ({ app, page }) => {
  await app.evaluate(({ ipcMain }, args) => ipcMain.emit(args.channel, {}, args.delayMs), {
    channel: TEST_CHANNELS.delayDraftInlineImage,
    delayMs: 500
  })
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-slow-image',
        'Slow inline image',
        '<p>Original body</p><p><img data-surl="cid:remote-inline" src="cid:remote-inline"></p>',
        '',
        true
      )
    }
  )
  if (error) throw new Error(error)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Slow inline image' }).click()
  const composer = new ComposerPage(page)
  await expect(composer.editor).toContainText('Original body')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await composer.typeBody(' typed before hydration')
  await expect(composer.editor.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(composer.editor).toContainText('Original body typed before hydration')
})

test('keeps a resolved inline image through the first undo', async ({ app, page }) => {
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-undo-image',
        'Undo inline image',
        '<p>Original body</p><p><img data-surl="cid:remote-inline" src="cid:remote-inline"></p>',
        '',
        true
      )
    }
  )
  if (error) throw new Error(error)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Undo inline image' }).click()
  const composer = new ComposerPage(page)
  const image = composer.editor.locator('img')
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)

  // Swapping the placeholder for the hydrated image is not an edit the user
  // made, so the first undo must not restore the transparent placeholder.
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(composer.editor).toContainText('Original body')
})

test('keeps the selected draft stable when a refresh reorders the list', async ({ page }) => {
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.evaluate(async () => {
    for (const subject of ['Older selection target', 'Newer draft']) {
      const { id } = await window.attn.draft.save({ ...emptyDraftInputForTest(), subject })
      await window.attn.draft.close(id)
      await new Promise((resolve) => window.setTimeout(resolve, 2))
    }

    function emptyDraftInputForTest() {
      return {
        id: null,
        kind: 'new' as const,
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        bodyHtml: '',
        bodyText: '',
        attachments: [],
        threadId: null,
        sourceMessageId: null,
        inReplyTo: null,
        references: [],
        quoteHtml: '',
        quoteText: '',
        followUpAt: null
      }
    }
  })
  await goToDrafts(page)
  await page.keyboard.press('j')
  const selectedId = await page.getByTestId('draft-row').nth(1).getAttribute('data-draft-id')
  await expect(page.getByTestId('draft-row').nth(1)).toHaveAttribute('data-selected', 'true')

  await page.evaluate(async () => {
    const input = {
      id: null,
      kind: 'new' as const,
      to: [],
      cc: [],
      bcc: [],
      subject: 'Newest refresh draft',
      bodyHtml: '',
      bodyText: '',
      attachments: [],
      threadId: null,
      sourceMessageId: null,
      inReplyTo: null,
      references: [],
      quoteHtml: '',
      quoteText: '',
      followUpAt: null
    }
    const { id } = await window.attn.draft.save(input)
    await window.attn.draft.close(id)
  })
  await expect(page.getByTestId('draft-row')).toHaveCount(3)
  await expect(page.getByTestId('draft-row').filter({ hasText: 'Older selection target' })).toHaveAttribute(
    'data-selected',
    'true'
  )
  expect(
    await page
      .getByTestId('draft-row')
      .filter({ hasText: 'Older selection target' })
      .getAttribute('data-draft-id')
  ).toBe(selectedId)
})

test('adopts closed remote edits, preserves Bcc, and defers an edit while open', async ({ app, page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Local draft')
  await composer.typeBody('Local body')
  await composer.expectSaved()
  const id = await composer.root.getAttribute('data-draft-id')
  if (!id) throw new Error('missing draft id')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  const mirrorError = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) =>
        ipcMain.emit(args.channel, {}, args.id, args.gmailId, resolve)
      ),
    {
      channel: TEST_CHANNELS.markDraftMirrored,
      id,
      gmailId: 'gmail-remote-1'
    }
  )
  if (mirrorError) throw new Error(mirrorError)
  const reconcile = async (subject: string, html: string): Promise<void> => {
    const error = await app.evaluate(
      ({ ipcMain }, args) =>
        new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
      {
        channel: TEST_CHANNELS.remoteDraft,
        remote: remoteDraft('gmail-remote-1', subject, html, 'secret@example.com')
      }
    )
    if (error) throw new Error(error)
  }

  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft(
        'gmail-remote-1',
        'Remote closed edit',
        '<table><tbody><tr><td>Remote table</td></tr></tbody></table><p><img src="cid:remote-inline"></p>',
        'secret@example.com',
        true
      )
    }
  )
  if (error) throw new Error(error)
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Remote closed edit' }).click()
  await expect(composer.subject).toHaveValue('Remote closed edit')
  await composer.expectRecipients(['secret@example.com'], 'bcc')
  await expect(composer.editor.locator('table')).toContainText('Remote table')
  await expect(composer.editor.locator('img')).toHaveCount(1)

  await reconcile('Deferred remote edit', '<p>Do not rewrite the open editor</p>')
  await expect(composer.subject).toHaveValue('Remote closed edit')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await reconcile('Deferred remote edit', '<p>Adopted after close</p>')
  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Deferred remote edit' }).click()
  await expect(composer.editor).toContainText('Adopted after close')
})

test('keeps multiple Gmail reply drafts on one thread distinct across sync cycles', async ({ app, page }) => {
  const remotes = [
    remoteReplyDraft('gmail-thread-reply-1', 'First Gmail reply', '<p>First remote reply</p>'),
    remoteReplyDraft('gmail-thread-reply-2', 'Second Gmail reply', '<p>Second remote reply</p>')
  ]
  const reconcile = async (): Promise<void> => {
    for (const remote of remotes) {
      const error = await app.evaluate(
        ({ ipcMain }, args) =>
          new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
        { channel: TEST_CHANNELS.remoteDraft, remote }
      )
      if (error) throw new Error(error)
    }
  }

  await reconcile()
  await goToDrafts(page)
  const first = page.getByTestId('draft-row').filter({ hasText: 'First Gmail reply' })
  const second = page.getByTestId('draft-row').filter({ hasText: 'Second Gmail reply' })
  await expect(first).toHaveCount(1)
  await expect(second).toHaveCount(1)
  const firstId = await first.getAttribute('data-draft-id')
  const secondId = await second.getAttribute('data-draft-id')
  expect(firstId).toBeTruthy()
  expect(secondId).toBeTruthy()
  expect(firstId).not.toBe(secondId)

  await reconcile()
  await expect(first).toHaveAttribute('data-draft-id', firstId ?? '')
  await expect(second).toHaveAttribute('data-draft-id', secondId ?? '')
})

test('persists content supplied while creating an id-less draft', async ({ page }) => {
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  const draft = await page.evaluate(async () => {
    const { id } = await window.attn.draft.save({
      id: null,
      kind: 'reply',
      to: [{ name: 'Prefilled', email: 'prefilled@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Prefilled subject',
      bodyHtml: '<p>Prefilled body</p>',
      bodyText: 'Prefilled body',
      attachments: [],
      threadId: 'future-reply-thread',
      sourceMessageId: 'future-source-message',
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>'],
      quoteHtml: '',
      quoteText: '',
      followUpAt: null
    })
    return window.attn.draft.get(id)
  })

  expect(draft).toMatchObject({
    to: [{ name: 'Prefilled', email: 'prefilled@example.com' }],
    subject: 'Prefilled subject',
    bodyHtml: '<p>Prefilled body</p>',
    bodyText: 'Prefilled body',
    threadId: 'future-reply-thread',
    inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>']
  })
})

test('lists every distinct draft after relaunch in newest-first order', async ({ boot, page }) => {
  await page.getByTestId('thread-list').waitFor({ state: 'attached' })
  await page.evaluate(async () => {
    for (const subject of ['First durable draft', 'Second durable draft', 'Third durable draft']) {
      const { id } = await window.attn.draft.save({
        id: null,
        kind: 'new',
        to: [],
        cc: [],
        bcc: [],
        subject,
        bodyHtml: '',
        bodyText: '',
        attachments: [],
        threadId: null,
        sourceMessageId: null,
        inReplyTo: null,
        references: [],
        quoteHtml: '',
        quoteText: '',
        followUpAt: null
      })
      await window.attn.draft.close(id)
      await new Promise((resolve) => window.setTimeout(resolve, 2))
    }
  })
  ;({ page } = await boot.relaunch())
  await goToDrafts(page)
  await expect(page.getByTestId('draft-row')).toHaveCount(3)
  await expect(page.getByTestId('draft-row').first()).toContainText('Third durable draft')
  await expect(page.getByTestId('draft-row').nth(1)).toContainText('Second durable draft')
  await expect(page.getByTestId('draft-row').last()).toContainText('First durable draft')
})

test('restores the same full-window reader after composing', async ({ page }) => {
  await page.getByTestId('thread-subject').getByText('Design notes', { exact: true }).click()
  const conversation = page.getByTestId('conversation-view')
  await expect(conversation).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const before = await selectedIndex(page)

  const composer = new ComposerPage(page)
  await composer.openNew()
  await expect(conversation).toBeHidden()
  await expect(page.getByTestId('footer-shortcuts')).toHaveCount(0)

  const account = page.getByTestId('account-menu').getByRole('button').first()
  await account.click()
  await page.keyboard.press('Escape')
  await expect(composer.root).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect(conversation).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  expect(await selectedIndex(page)).toBe(before)
})

test('recovers a mirrored draft after relaunch without making initial content undoable', async ({
  app,
  boot,
  page
}) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('priya@example.com')
  await composer.subject.fill('Relaunch recovery')
  await composer.editor.click()
  await composer.typeBody('This draft survives a renderer and main-process restart.')

  // Let the trailing one-second checkpoint finish before simulating the crash.
  await composer.expectSaved()
  const draftId = await composer.root.getAttribute('data-draft-id')
  if (!draftId) throw new Error('composer did not expose its draft id')
  await app.evaluate(({ ipcMain }, { channel, id }) => ipcMain.emit(channel, {}, id), {
    channel: TEST_CHANNELS.markDraftMirrored,
    id: draftId
  })
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['priya@example.com'])
  await expect(composer.subject).toHaveValue('Relaunch recovery')
  await expect(composer.editor).toContainText('This draft survives a renderer and main-process restart.')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(composer.editor).toContainText('This draft survives a renderer and main-process restart.')
})

test('checkpoints a complete recipient while its field remains focused', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  const input = composer.recipientField().locator('input')

  await input.fill('focused@example.com')
  await expect.poll(() => input.evaluate((field) => document.activeElement === field)).toBe(true)
  await composer.expectSaved()
  await composer.expectRecipients(['focused@example.com'])

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await composer.expectRecipients(['focused@example.com'])
})

test('checkpoints continuously typed content without waiting for an idle gap', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.click()
  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  await page.clock.pauseAt(clockStart + 1_000)
  const continuous = 'Continuous typing still reaches durable storage before an idle debounce can ever fire.'

  // Keep resetting the one-second idle timer, then cross the five-second hard
  // checkpoint. The fake renderer clock runs the production timers without an
  // eight-second wall-clock delay.
  for (let index = 0; index < 6; index++) {
    const chunk = continuous.slice(
      Math.floor((index * continuous.length) / 6),
      Math.floor(((index + 1) * continuous.length) / 6)
    )
    await page.keyboard.type(chunk)
    await page.clock.fastForward(900)
  }
  // Time is paused 100ms before the trailing idle save could run. This read
  // proves the hard checkpoint reached SQLite before the app is killed.
  await composer.expectSaved()
  ;({ page } = await boot.relaunch({ kill: true }))
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText(continuous)
})

test('retries a failed autosave without clearing the dirty checkpoint', async ({ app, boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}), TEST_CHANNELS.failNextDraftSave)

  await composer.subject.fill('Retry this checkpoint')
  await expect(page.getByTestId('composer-save-status')).toHaveAttribute('data-save-status', 'error')
  await composer.expectSaved()

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(composer.subject).toHaveValue('Retry this checkpoint')
})

test('discard removes the local recovery surface', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Sensitive local draft')
  await composer.typeBody('Do not recover this text.')
  await composer.expectSaved()
  await page.getByTestId('composer-discard').click()
  await expect(composer.root).toHaveCount(0)

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toHaveCount(0)
})

test('keeps the caret in a recipient field while a preserved region sits in the body', async ({
  app,
  boot,
  page
}) => {
  // A reply whose body carries markup the editor cannot represent — the shape a
  // reply takes once it has round-tripped through Gmail with a rich quoted
  // trail. Registering a Lexical node transform runs it over the whole document
  // inside an editor update, and that update writes the DOM selection back into
  // the editor, so an unstable plugin prop steals the caret on every keystroke.
  await page.evaluate(async () => {
    await window.attn?.draft.save({
      id: null,
      kind: 'reply',
      to: [],
      cc: [],
      bcc: [],
      subject: 'Re: Roadmap',
      // The links matter: the transform that gets re-registered is the one that
      // scans for URLs, so it only dirties nodes when the body contains some.
      bodyHtml:
        '<div>my reply</div><div><a href="https://attn.test/agenda">agenda</a> and https://attn.test/more</div>' +
        '<section data-layout="card"><table><tr><td><a href="https://attn.test/x">Preserved region</a></td></tr></table></section>',
      bodyText: 'my reply',
      attachments: [],
      threadId: 't-roadmap',
      sourceMessageId: null,
      inReplyTo: null,
      references: [],
      quoteHtml: '',
      quoteText: '',
      followUpAt: null
    })
  })

  // Relaunch so the draft is reloaded from the store, then leave the recovered
  // full-window composer and reopen the draft inline on its own thread.
  ;({ app, page } = await boot.relaunch())
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  // A fast reply shortcut must not replace the saved draft while its reopen is
  // still crossing IPC, especially when an imported draft has no known source.
  await app.evaluate(({ ipcMain }, args) => ipcMain.emit(args.channel, {}, args.delayMs), {
    channel: TEST_CHANNELS.delayDraftReopen,
    delayMs: 500
  })
  await page.getByTestId('thread-row').first().click()
  await page.keyboard.press('Enter')
  // Inline placement is load-bearing: the editor only takes focus on open in
  // this mode, which is what leaves a selection for the update to write back.
  await expect(composer.editor).toBeFocused()
  await composer.expandRecipients()
  await expect(page.getByTestId('conversation-view').getByTestId('composer-to')).toBeVisible()
  await expect(page.getByTestId('composer-editor').locator('iframe')).toHaveCount(1)

  const to = page.getByTestId('composer-to').locator('input').first()
  await to.click()
  await page.keyboard.type('a')
  // Waiting for the checkpoint is what makes this deterministic: the caret used
  // to move during the render and effect cycle that the first edit kicks off.
  await expect(page.getByTestId('composer-save-status')).toHaveAttribute('data-save-status', 'saved')
  await page.keyboard.type('da@attn.test')

  await expect(to).toHaveValue('ada@attn.test')
})

test('restores the collapsed quote on a reply Gmail merged into one document', async ({ app, page }) => {
  // Gmail stores a draft as a single document, so Attn's own reply comes back
  // with its quoted trail joined to the body. Left merged, the quoted mail
  // loads into the editor: a newsletter freezes into a read-only region and the
  // banner appears over content the author never wrote.
  const merged =
    '<div>my answer</div>\n<div>On Sun, 16 Aug 2026, AlphaSignal wrote:</div>' +
    '<blockquote><table role="presentation" width="600"><tr><td bgcolor="#f6d5c4">Newsletter</td></tr></table></blockquote>'
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteDraft('merged-reply', 'Re: Newsletter', merged, '', false, undefined, [
        { name: 'In-Reply-To', value: '<original@attn.test>' }
      ])
    }
  )
  if (error) throw new Error(error)

  await goToDrafts(page)
  await page.getByTestId('draft-row').filter({ hasText: 'Re: Newsletter' }).click()
  const composer = new ComposerPage(page)
  await expect(composer.editor).toContainText('my answer')

  // The quoted trail belongs to the collapsed quote, not the editor.
  await expect(page.getByTestId('composer-quote-container')).toHaveCount(1)
  await expect(composer.editor).not.toContainText('Newsletter')
  await expect(composer.editor.locator('iframe[title="Preserved draft content"]')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
})

test('keeps a reply signature and quoted history collapsed with empty lines beside nested wrappers', async ({
  app,
  page
}, testInfo) => {
  const signature =
    '<div class="gmail_signature" data-smartmail="gmail_signature"><div>Bests,</div><div>Alex Rivera</div><a href="https://northstar.test/">Northstar</a></div>'
  const emptyLine = '<div><br></div>'
  const merged = `<div dir="ltr"><div>${emptyLine}${signature}<div class="gmail_quote"><div class="gmail_attr">On Mon, Christy wrote:</div><blockquote><table width="600"><tr><td>Internal account notes.</td></tr></table></blockquote></div>${emptyLine}</div>${emptyLine}</div>`
  const error = await app.evaluate(
    ({ ipcMain }, args) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(args.channel, {}, args.remote, resolve)),
    {
      channel: TEST_CHANNELS.remoteDraft,
      remote: remoteReplyDraft('reply-empty-lines', 'Re: Q3 roadmap review', merged)
    }
  )
  if (error) throw new Error(error)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  const composer = new ComposerPage(page)
  await composer.expectSignatureAndQuoteCollapsed()
  await expect(composer.editor.locator('iframe')).toHaveCount(0)
  await expect(page.getByTestId('composer-preserved-banner')).toHaveCount(0)
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'composer-reply-empty-lines.png')
  await page.screenshot({ path })
  await testInfo.attach('reply with Gmail empty lines beside nested wrappers', {
    path,
    contentType: 'image/png'
  })
  await composer.revealSignatureWithKeyboard()
  await expect(composer.signature).toContainText('Alex Rivera')
  await expect(page.frameLocator('[data-testid="composer-quote"]').locator('body')).toContainText(
    'Internal account notes.'
  )
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+Home')
  await composer.typeBody('My reply')
  await composer.expectSaved()
  const saved = await page.evaluate(
    async (id) => window.attn.draft.get(id ?? ''),
    await composer.root.getAttribute('data-draft-id')
  )
  expect(saved?.bodyText).toContain('My reply')
  expect(saved?.bodyHtml).toContain('gmail_signature')
  expect(saved?.bodyHtml).not.toContain('gmail_quote')
  expect(saved?.quoteHtml).toContain('Internal account notes.')
  expect(saved?.quoteHtml.endsWith(emptyLine.repeat(2))).toBe(true)
  const savedId = await composer.root.getAttribute('data-draft-id')
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  // This imported draft has no known source. Reopen that saved draft instead
  // of asking R to start a reply to the currently selected message.
  await page.getByTestId('conversation-back').click()
  await page.getByTestId('thread-subject').getByText('Q3 roadmap review', { exact: true }).click()
  await expect(composer.root).toHaveAttribute('data-draft-id', savedId ?? '')
  await composer.expectSignatureAndQuoteCollapsed()
  await expect(composer.editor).toContainText('My reply')
  const reopened = await page.evaluate(async (id) => window.attn.draft.get(id ?? ''), savedId)
  expect(reopened?.quoteHtml).toBe(saved?.quoteHtml)
})

test('quit checkpoints composer text no autosave timer has reached yet (B28)', async ({ boot, page }) => {
  let composer = new ComposerPage(page)
  await composer.openNew()
  await composer.editor.click()
  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  // Freeze time well inside the one-second idle debounce: neither checkpoint
  // timer can fire, so only the pre-quit request can reach SQLite.
  await page.clock.pauseAt(clockStart + 100)
  const typed = 'Quit must not drop this sentence.'
  await page.keyboard.type(typed)
  await expect(composer.editor).toContainText(typed)

  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText(typed)
})

test('confirms an empty subject with Escape and Mod+Enter without losing the draft', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('recipient@example.com')
  await composer.typeBody('Keep this text while confirming.')
  await composer.triggerSend()
  const confirmation = page.getByTestId('no-subject-confirmation')
  await expect(confirmation).toBeVisible()
  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  await page.screenshot({ path: join(__dirname, '.artifacts/composer-no-subject.png') })
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(composer.editor).toContainText('Keep this text while confirming.')
  await composer.triggerSend()
  await expect(confirmation).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(confirmation).toHaveCount(0)
  await composer.expectPending(1)
})

test('opens formatting by shortcut and applies numbered and bulleted lists', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('List item')
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await expect(page.getByTestId('composer-selection-toolbar')).toBeVisible()
  await page.keyboard.press('Escape')
  await composer.editor.click()
  await page.keyboard.press('ControlOrMeta+Shift+7')
  await expect(composer.editor.locator('ol')).toContainText('List item')
  await page.keyboard.press('ControlOrMeta+Shift+8')
  await expect(composer.editor.locator('ul')).toContainText('List item')
})

test('Escape dismisses a selection toolbar before closing the draft', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Keep this selected text')
  await composer.editor.locator('p').first().selectText()
  const toolbar = page.getByTestId('composer-selection-toolbar')
  await expect(toolbar).toBeVisible()
  await expect(composer.editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toolbar).toHaveCount(0)
  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toBeFocused()
  await expect(composer.editor).toContainText('Keep this selected text')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
})

test('Drafts and Outbox display whitespace subjects without changing their stored value', async ({
  page
}) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('recipient@example.com')
  await composer.subject.fill('   ')
  await composer.typeBody('Whitespace subject body')
  await composer.expectSaved()
  await page.getByTestId('composer-close').click()
  await goToDrafts(page)
  const row = page.getByTestId('draft-row').filter({ hasText: 'Whitespace subject body' })
  await expect(row).toContainText('(no subject)')
  await row.click()
  await expect(composer.subject).toHaveValue('   ')
  await composer.triggerSend()
  await expect(page.getByTestId('no-subject-confirmation')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(composer.root).toHaveCount(0)
  await page.getByTestId('outbox-count').click()
  await expect(page.getByTestId('outbox-row')).toContainText('(no subject)')
  await page.getByTestId('outbox-open').click()
  await expect(composer.subject).toHaveValue('   ')
})

test('snapshots complex clipboard CSS with the browser cascade through save and reopen', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('https://clipboard-resource.attn.test/**', (route) => route.abort())
  const cases: string[][] = [
    ['', '<body style="background:red;padding:20px"><p>Text</p></body>', 'div', 'padding', '20px'],
    [
      '',
      '<html style="background:red;padding:20px"><body><p>Text</p></body></html>',
      'div',
      'padding',
      '20px'
    ],
    [
      '.parent {color:red}.child {color:black}',
      '<div class="parent"><span class="child">Text</span></div>',
      'span',
      'color',
      'rgb(0, 0, 0)'
    ],

    ['body.theme p {color:red}', '<body class="theme"><p>Text</p></body>', 'span', 'color', 'red'],

    ['body {background:red;padding:20px}', '<p>Text</p>', 'div', 'padding', '20px'],
    ['body {background:red;padding:20px}', '<p>Text</p>', 'div', 'background-color', 'rgb(255, 0, 0)'],
    ['.secret {visibility:hidden}', '<p class="secret">Text</p>', 'p', 'visibility', 'hidden'],

    [
      '.x {display:inline;opacity:.5;transform:rotate(5deg);letter-spacing:2px}',
      '<p class="x">Text</p>',
      'p',
      'opacity',
      '0.5'
    ],
    [
      'img[src] {border:5px solid red}',
      '<img src="https://clipboard-resource.attn.test/picture.png" alt="Picture">',
      'img',
      'border-width',
      '5px'
    ],

    [
      '@scope (.outer) {.x {color:red}}',
      '<div class="outer"><p class="x">Text</p></div>',
      'span',
      'color',
      'red'
    ],
    [
      '@layer outer {@layer second, first; @layer first {.x{color:red}} @layer second {.x{color:blue}}}',
      '<p class="x">Text</p>',
      'span',
      'color',
      'red'
    ],
    [
      '',
      '<div style="--accent:red;color:green"><span style="--accent:inherit;color:var(--accent)">Text</span></div>',
      'span',
      'color',
      'red'
    ],
    [
      '',
      '<div style="--accent:red"><span style="--accent:initial;color:var(--accent,blue)">Text</span></div>',
      'span',
      'color',
      'blue'
    ],
    ['.x {--Accent:red;color:var(--Accent)}', '<p class="x">Text</p>', 'span', 'color', 'red'],
    [
      '.parent {--accent:red}.x {color:var(--missing,var(--accent))}',
      '<div class="parent"><p class="x">Text</p></div>',
      'span',
      'color',
      'red'
    ],
    ['@layer base {.x {color:red}}', '<p class="x">Text</p>', 'span', 'color', 'red'],
    ['@layer base {.x {color:red}} .x {color:blue}', '<p class="x">Text</p>', 'span', 'color', 'blue'],
    [
      '@layer base {.x {color:red!important}} .x {color:blue!important}',
      '<p class="x">Text</p>',
      'span',
      'color',
      'red'
    ],
    ['table {width:500px}', '<table><tr><td>Cell</td></tr></table>', 'table', 'width', '500px'],
    [
      '@media screen {table {width:400px}}',
      '<table><tr><td>Cell</td></tr></table>',
      'table',
      'width',
      '400px'
    ],
    [
      'table {width:500px!important}',
      '<table style="width:200px"><tr><td>Cell</td></tr></table>',
      'table',
      'width',
      '500px'
    ],
    ['td.td1 {padding:8px}', '<table><tr><td class="td1">Cell</td></tr></table>', 'td', 'padding', '8px'],
    [
      'table.t1 {border-spacing:4px}',
      '<table class="t1"><tr><td>Cell</td></tr></table>',
      'table',
      'border-spacing',
      '4px'
    ],
    [
      'tr.t1 {text-align:right}',
      '<table><tr class="t1"><td>Cell</td></tr></table>',
      'tr',
      'text-align',
      'right'
    ]
  ]
  cases.push(
    ['.x::before {content:"★";color:red}', '<p class="x">Text</p>', 'span', 'color', 'red'],
    [
      '@scope (.outer) {:scope > .x {color:red}}',
      '<div class="outer"><p class="x">Text</p></div>',
      'span',
      'color',
      'red'
    ],
    [
      '@scope (.inner) {.x {color:red}} @scope (.outer) {.x {color:blue}}',
      '<div class="outer"><div class="inner"><p class="x">Text</p></div></div>',
      'span',
      'color',
      'red'
    ],
    [
      '.parent {color:red}.child {color:inherit}',
      '<div class="parent"><span class="child">Text</span></div>',
      'span',
      'color',
      'red'
    ],
    [
      '@layer base {.x{--c:red}} @layer theme {.x{--c:revert-layer}} .x{color:var(--c,blue)}',
      '<p class="x">Text</p>',
      'span',
      'color',
      'red'
    ]
  )
  for (const [index, [css, body, selector, property, expected]] of cases.entries()) {
    const composer = new ComposerPage(page)
    await composer.openNew()
    const subject = `CSS snapshot ${index}`
    await composer.subject.fill(subject)
    await composer.editor.click()
    await pasteHtml(
      composer,
      `<meta name="Generator" content="Cocoa HTML Writer"><style>${css}</style>${body}`
    )
    await composer.expectSaved()
    const check = async (): Promise<void> => {
      const result = await page.evaluate(
        async ({ subject, selector, property, expected }) => {
          const draft = (await window.attn.draft.list()).find((item) => item.subject === subject)
          const saved = draft ? await window.attn.draft.get(draft.id) : null
          const document = new DOMParser().parseFromString(saved?.bodyHtml ?? '', 'text/html')
          const probe = document.createElement('span')
          probe.style.setProperty(property, expected)
          const wanted = probe.style.getPropertyValue(property)
          return {
            html: saved?.bodyHtml,
            matches: [...document.querySelectorAll<HTMLElement>(selector)].some(
              (element) =>
                element.style.getPropertyValue(property) === wanted ||
                (property === 'color' &&
                  element.style.color ===
                    ({ red: 'rgb(255, 0, 0)', blue: 'rgb(0, 0, 255)' } as Record<string, string>)[expected])
            )
          }
        },
        { subject, selector, property, expected }
      )
      expect(result.matches, JSON.stringify({ css, ...result })).toBe(true)
      if (css.includes('::before')) expect(result.html).toContain('★')
    }
    await check()
    if (css.includes('::before')) {
      await page.mouse.move(0, 0)
      await page.screenshot({ path: join(__dirname, '.artifacts/clipboard-css-snapshot.png') })
    }
    await page.keyboard.press('Escape')
    await goToDrafts(page)
    await page
      .getByTestId('draft-row')
      .filter({ has: page.getByText(subject, { exact: true }) })
      .click()
    await expect(composer.root).toBeVisible()
    await expect(composer.editor).toBeVisible()
    await check()
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('g')
    await page.keyboard.press('i')
    await expect(page.getByTestId('thread-list')).toBeVisible()
  }
})

test('clipboard CSS snapshot cannot execute scripts or load CSS resources', async ({ page }) => {
  const requests: string[] = []
  await page.route('https://clipboard-resource.attn.test/**', async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('CSS isolation')
  await composer.editor.click()
  await pasteHtml(
    composer,
    '<style>@import url("https://clipboard-resource.attn.test/import.css"); .x {color:red;background-image:url("https://clipboard-resource.attn.test/image.png")}</style><p class="x" onclick="window.clipboardScriptRan=true">Safe text</p><script>window.clipboardScriptRan=true</script>'
  )
  await composer.expectSaved()
  expect(await page.evaluate(() => 'clipboardScriptRan' in window)).toBe(false)
  expect(requests).toEqual([])
  expect(await page.locator('iframe[aria-hidden="true"]').count()).toBe(0)
})

test('materializes clipboard attributes, counters, quotes, and list markers', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Generated CSS text')
  await composer.editor.click()
  await pasteHtml(
    composer,
    `<style>
    .attribute::before {content:attr(data-label)}
    .alternative::before {content:"★/" / "star"}
    .image-content::before {content:url("https://clipboard-resource.attn.test/icons/check.svg") / "check"}
    .image-label::before {content:url(https://clipboard-resource.attn.test/icons/check.svg) "Label" / "mixed"}
    .numbered {counter-reset:item}
    .numbered p::before {counter-increment:item;content:counter(item) ". "}
    @counter-style thumbs {system:cyclic;symbols:"👍"}
    .thumbs {counter-reset:item}
    .thumbs::before {counter-increment:item;content:counter(item, thumbs) " "}
    .unicode {counter-reset:café} .unicode::before {counter-increment:café;content:counter(café) " "}
    .sibling {counter-reset:x 1}
    .sibling::before {content:counters(x, ".") " "}
    .greek {counter-reset:item}
    .greek::before {counter-increment:item;content:counter(item, lower-greek) " ";}
    .quoted::before {content:open-quote}
    .quoted::after {content:close-quote}
    .markers li::marker {content:"✓ ";color:red}
  </style><p class="image-content">Image</p><p class="image-label">Tail</p><p class="alternative">Symbol</p><p class="attribute" data-label="Prefix ">Attribute</p><div class="numbered"><p>First</p><p>Second</p></div><p class="thumbs">Custom</p><p class="unicode">Unicode</p><p class="sibling">Sibling A</p><p class="sibling">Sibling B</p><p class="greek">Greek</p><p class="quoted">Quoted</p><ul class="markers"><li>Marked</li></ul>`
  )
  await composer.expectSaved()
  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'Generated CSS text')
    return draft ? await window.attn.draft.get(draft.id) : null
  })
  const text = await page.evaluate(
    (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent,
    saved?.bodyHtml ?? ''
  )
  expect(saved?.bodyHtml).toContain('aria-label="check"')
  expect(saved?.bodyHtml).toContain('aria-label="mixed"')
  expect(saved?.bodyHtml).not.toMatch(/<img[^>]*alt="check"/)
  expect(text).toContain('LabelTail')
  expect(text).not.toContain('icons/check.svg')
  expect(text).toContain('★/Symbol')
  expect(text).not.toContain('star')
  expect(saved?.bodyHtml).toContain('aria-label="star"')
  expect(text).toContain('Prefix Attribute')
  expect(text).toContain('1. First')
  expect(text).toContain('2. Second')
  expect(text).toContain('“Quoted”')
  expect(text).toContain('α Greek')
  expect(text).toContain('👍 Custom')
  expect(text).toContain('1 Unicode')
  expect(saved?.bodyHtml?.match(/<img[^>]+clipboard-resource\.attn\.test/g)).toHaveLength(2)
  expect(text).toContain('1 Sibling A1 Sibling B')
  expect(text).toContain('✓ Marked')
  expect(saved?.bodyHtml).toContain('list-style-type: none')
  await expect(composer.editor.locator('iframe')).toHaveCount(4)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(__dirname, '.artifacts/clipboard-generated-content.png') })
})

test('preserves generated color resets and implicit ordered list counters', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Generated resets and lists')
  await composer.editor.click()
  await pasteHtml(
    composer,
    `<style>
    .parent {color:red} .child::before {content:"X";color:black}
    ol li::marker {content:counter(list-item, lower-roman) ". "}
    .reset {counter-reset:list-item 9}
    .item-reset li {counter-reset:list-item 9}
    u.plain {text-decoration:none}
    @counter-style hands {system:cyclic;symbols:"👍";prefix:"[";suffix:"] "}
    .hands {list-style-type:hands} .hands li::marker {content:normal}
    </style><div class="parent"><p class="child">Red</p></div>
    <ol><li>One</li><li>Two</li></ol>
    <ol start="3"><li>Three</li><li value="5">Five</li><li>Six</li></ol>
    <ol reversed><li>Down two</li><li>Down one</li></ol><ol class="reset"><li>Ten</li><li>Eleven</li></ol><ol class="hands"><li>Hand</li></ol><ol class="item-reset"><li>Item ten</li></ol><iframe src="https://example.com" title="Demo"></iframe><p><u class="plain">Undecorated</u><u style="text-decoration:red none">Undecorated unordered</u></p><p><u><span style="text-decoration:none">Underlined</span></u><s><span style="text-decoration:none">Struck</span></s></p>`
  )
  await composer.expectSaved()
  const saved = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find(
      (item) => item.subject === 'Generated resets and lists'
    )
    const html = draft ? ((await window.attn.draft.get(draft.id))?.bodyHtml ?? '') : ''
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return {
      text: doc.body.textContent,
      html,
      unwantedUnderline: [...doc.querySelectorAll('u')].some((element) =>
        element.textContent?.includes('Undecorated')
      ),
      black: [...doc.querySelectorAll('span')].some(
        (span) => span.textContent === 'X' && ['black', 'rgb(0, 0, 0)'].includes(span.style.color)
      )
    }
  })
  expect(saved.text?.match(/\[👍\]/g)).toHaveLength(1)
  expect(saved.black).toBe(true)
  expect(saved.unwantedUnderline, saved.html).toBe(false)
  for (const label of [
    'i. One',
    'ii. Two',
    'iii. Three',
    'v. Five',
    'vi. Six',
    'ii. Down two',
    'i. Down one',
    'x. Ten',
    'xi. Eleven',
    '[👍] Hand',
    'x. Item ten',
    'Demo'
  ])
    expect(saved.text).toContain(label)
})

test('uses the application viewport for clipboard media queries', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Clipboard media viewport')
  const width = await page.evaluate(() => window.innerWidth)
  const css =
    width > 800
      ? `@media (min-width:${width - 1}px) {p {color:blue}}`
      : `@media (max-width:${width + 1}px) {p {color:blue}}`
  await composer.editor.click()
  await pasteHtml(composer, `<style>${css}</style><p>Viewport text</p>`)
  await composer.expectSaved()
  const html = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'Clipboard media viewport')
    return draft ? (await window.attn.draft.get(draft.id))?.bodyHtml : ''
  })
  expect(html).toContain('rgb(0, 0, 255)')
})

test('retains unstyled clipboard body direction', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('RTL clipboard')
  await composer.editor.click()
  await pasteHtml(composer, '<body dir="rtl"><p>مرحبا</p></body>')
  await composer.expectSaved()
  const html = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'RTL clipboard')
    return draft ? (await window.attn.draft.get(draft.id))?.bodyHtml : ''
  })
  expect(html).toContain('dir="rtl"')
})

test('preserves clipboard CSS direction and wrapper language', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Clipboard language')
  await composer.editor.click()
  await pasteHtml(composer, '<body lang="fr"><p>Bonjour</p></body>')
  await pasteHtml(
    composer,
    '<style>p {direction:rtl;text-align:start;float:right;clear:both}</style><p>مرحبا</p>'
  )
  await composer.expectSaved()
  const html = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'Clipboard language')
    return draft ? (await window.attn.draft.get(draft.id))?.bodyHtml : ''
  })
  expect(html).toContain('lang="fr"')
  expect(html).toMatch(/direction:\s*rtl/)
  expect(html).toMatch(/float:\s*right/)
  expect(html).toMatch(/clear:\s*both/)
})

test('preserves empty generated layout and flex item order', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.subject.fill('Clipboard layout boxes')
  await composer.editor.click()
  await pasteHtml(
    composer,
    `<style>
    .clearfix::after {content:"";display:table;clear:both}
    .floating {float:left} .row {display:flex} .second {order:-1}
    </style><div class="clearfix"><div class="floating">Float</div></div><div class="row"><div>First</div><div class="second">Second</div></div>`
  )
  await composer.expectSaved()
  const html = await page.evaluate(async () => {
    const draft = (await window.attn.draft.list()).find((item) => item.subject === 'Clipboard layout boxes')
    return draft ? (await window.attn.draft.get(draft.id))?.bodyHtml : ''
  })
  expect(html).toMatch(/clear:\s*both/)
  expect(html).toMatch(/display:\s*table/)
  expect(html).toMatch(/order:\s*-1/)
})
