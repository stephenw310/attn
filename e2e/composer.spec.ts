import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })
test.setTimeout(60_000)

function selectedIndex(page: Page): Promise<number> {
  return page
    .getByTestId('thread-row')
    .evaluateAll((rows) => rows.findIndex((row) => row.hasAttribute('data-selected')))
}

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

test('opens the first-class Drafts view with g d', async ({ page }) => {
  await goToDrafts(page)
  await expect(page.getByTestId('view-title')).toHaveText('Drafts')
})

test('inserts the saved Gmail signature into new mail as editable content', async ({ app, page }) => {
  await setSendAsSignature(
    app,
    '<div style="color:#2457a6">Best,</div><div>Chao Wu</div><div><a href="https://chaowu.xyz">chaowu.xyz</a></div>'
  )
  const composer = new ComposerPage(page)
  await composer.openNew()

  const signature = composer.editor.getByTestId('composer-gmail-signature')
  await expect(signature).toHaveCount(1)
  await expect
    .poll(() => composer.editor.evaluate((element) => getComputedStyle(element).fontFamily))
    .toContain('Inter Variable')
  await expect(composer.editor).toHaveCSS('font-size', '13px')
  await expect(composer.editor).toHaveCSS('line-height', '20px')
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
  expect(saved?.html).toContain('class="gmail_signature"')
  expect(saved?.html.indexOf('Hello from Attn')).toBeLessThan(saved?.html.indexOf('Best,') ?? -1)
  expect(saved?.text).toContain('Hello from Attn')
  expect(saved?.text).toContain('Best,')
})

test('discards signature-only new mail after the saved Gmail signature changes', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  await composer.openNew()
  await expect(composer.editor.getByTestId('composer-gmail-signature')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)

  await setSendAsSignature(app, '<div>Regards,</div><div>Chao Wu</div>')
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)

  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await window.attn.draft.list()).length)).toBe(0)
})

test('keeps formatting edits made inside the saved Gmail signature', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  await composer.openNew()

  await composer.editor.getByText('Best,').selectText()
  await page.getByRole('button', { name: 'Bold' }).click()
  await composer.expectSaved()
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)

  const drafts = await page.evaluate(async () => window.attn.draft.list())
  expect(drafts).toHaveLength(1)
  expect(drafts[0]?.bodyHtml).toContain('Best,')
  expect(drafts[0]?.bodyHtml).toMatch(/<(?:b|strong)\b/)
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
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(receipt.getByTestId('chip-draft')).toBeVisible()

  await receipt.click()
  await expect(composer.root).toHaveAttribute('data-draft-kind', 'forward')
  await expect(composer.attachmentChips).toHaveCount(1)
  await expect(composer.attachmentChips).toContainText('receipt.pdf')
})

test('adds a signature and discards an untouched forward with a source attachment', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const receipt = page.getByTestId('thread-row').filter({ hasText: 'Your receipt' })
  await receipt.click()
  await page.keyboard.press('f')
  await expect(page.getByTestId('composer-gmail-signature')).toContainText('Chao Wu')
  await expect(page.getByTestId('composer-attachment-chip')).toContainText('receipt.pdf')

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

test('queues durably and undo send reopens the intact composer', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.addRecipient('undo@example.com')
  await composer.subject.fill('Undo send keeps this draft')
  await composer.typeBody('Nothing reaches the provider before the local undo window closes.')

  await composer.triggerSend()

  await expect(composer.root).toHaveCount(0)
  const toast = page.getByTestId('toast')
  await expect(toast).toHaveText('Sent — Undo (Z)')
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
  await page.keyboard.press('z')

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
  await composer.pickAttachments()

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
})

test('renders coarse attachment upload progress in the global toast', async ({ app, page }) => {
  await page.getByTestId('thread-list').waitFor()
  await app.evaluate(
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

  await expect(page.getByTestId('toast')).toContainText('Sending attachments… 1 of 2')
  await expect(page.getByTestId('outbox-progress')).toHaveAttribute('data-completed-attachments', '1')
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

  ;({ page } = await boot.relaunch())
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

  const toInput = composer.recipientField().locator('input')
  await expect.poll(() => toInput.evaluate((input) => document.activeElement === input)).toBe(true)

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

test('adds links from the toolbar and the registered composer shortcut', async ({ page }) => {
  const composer = new ComposerPage(page)
  await composer.openNew()
  await composer.typeBody('Visit Attn')
  await composer.editor.selectText()

  await page.getByTestId('composer-link').click()
  await page.getByTestId('composer-link-url').fill('attn.test')
  await page.getByTestId('composer-link-url').press('Enter')
  await expect(composer.editor.locator('a').first()).toHaveAttribute('href', 'https://attn.test')

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
  await expect(page.getByTestId('conversation-back')).toBeEnabled()
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
  await expect(page.getByTestId('draft-list')).toBeVisible()

  await draft.click()
  await page.getByTestId('composer-close').click()
  await expect(composer.root).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await page.keyboard.press('j')
  await expect(page.getByTestId('draft-list')).toBeVisible()
})

test('adds a signature, discards an untouched reply, and keeps authored text', async ({ app, page }) => {
  await setSendAsSignature(app, '<div>Best,</div><div>Chao Wu</div>')
  const composer = new ComposerPage(page)
  const design = page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await design.click()
  await composer.openReply()
  await expect(composer.root).toBeVisible()
  await expect(composer.editor.getByTestId('composer-gmail-signature')).toContainText('Chao Wu')
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
  await expect(design.getByTestId('chip-draft')).toBeVisible()
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
  await expect(composer.editor.getByTestId('composer-gmail-signature')).toContainText('Chao Wu')
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
  await expect(page.getByTestId('conversation-back')).toContainText('Drafts')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer')).toHaveCount(0)
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
  await expect(page.getByTestId('conversation-back')).toContainText('Drafts')
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
        quoteText: ''
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
    '<div dir="ltr"><div>Draft from Gmail</div><div><img data-surl="cid:remote-inline" src="cid:remote-inline" alt="Gmail inline image" width="180"></div><div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr"><div>Best,</div><div>Chao Wu</div><div><a href="https://chaowu.xyz" target="_blank">https://chaowu.xyz</a></div></div></div>'
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
  const signature = composer.editor.getByTestId('composer-gmail-signature')
  await expect(signature).toHaveCount(1)
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
  expect(savedHtml).toContain('<div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr">')
  expect(savedHtml).toContain('Chao Wu — edited')
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
        quoteText: ''
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
      quoteText: ''
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
      quoteText: ''
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
        quoteText: ''
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
  const continuous = 'Continuous typing still reaches durable storage before an idle debounce can ever fire.'

  // Eight seconds of uninterrupted input crosses the five-second hard checkpoint.
  // Relaunch immediately after the last character, before the one-second idle timer.
  await composer.editor.pressSequentially(continuous, { delay: 100 })
  ;({ page } = await boot.relaunch())
  composer = new ComposerPage(page)

  await expect(composer.root).toBeVisible()
  await expect(composer.editor).toContainText(continuous.slice(0, 40))
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
      quoteText: ''
    })
  })

  // Relaunch so the draft is reloaded from the store, then leave the recovered
  // full-window composer and reopen the draft inline on its own thread.
  ;({ page } = await boot.relaunch())
  const composer = new ComposerPage(page)
  await expect(composer.root).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await page.getByTestId('thread-row').first().click()
  await page.keyboard.press('Enter')
  // Inline placement is load-bearing: the editor only takes focus on open in
  // this mode, which is what leaves a selection for the update to write back.
  await expect(page.getByTestId('conversation-view').getByTestId('composer-to')).toBeVisible()
  await expect(page.getByTestId('composer-editor').locator('iframe')).toHaveCount(1)
  await expect(page.getByTestId('composer-editor')).toBeFocused()

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
