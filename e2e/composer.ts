import { expect, type Locator, type Page } from '@playwright/test'

export type RecipientField = 'to' | 'cc' | 'bcc'

/**
 * Declarative driver shared by the composer, draft, send, and attachment suites.
 *
 * Recipient chips expose their normalized address as `data-email`; their visible
 * text remains free to include the display name. Keeping that contract here lets
 * specs assert reply planning without knowing the composer's DOM structure.
 *
 * Composer state settles asynchronously — reply planning and outbox transitions
 * both round-trip through IPC — so the reads here are retrying assertions rather
 * than snapshots. A one-shot read would observe the pre-IPC state and pass for
 * the wrong reason, which is exactly the failure an undo-send spec cannot catch.
 */
export class ComposerPage {
  private lastSavedRevision = 0

  constructor(private readonly page: Page) {}

  get root(): Locator {
    return this.page.getByTestId('composer')
  }

  get subject(): Locator {
    return this.page.getByTestId('composer-subject')
  }

  get editor(): Locator {
    return this.page.getByTestId('composer-editor')
  }

  get attachments(): Locator {
    return this.page.getByTestId('composer-attachments')
  }

  get attachmentChips(): Locator {
    return this.page.getByTestId('composer-attachment-chip')
  }

  async openNew(): Promise<void> {
    // firstWindow() can resolve while React is still mounting; wait for the
    // inbox command registry before sending the single global keystroke.
    await this.page.getByTestId('thread-list').waitFor({ state: 'attached' })
    await this.page.keyboard.press('c')
    await this.root.waitFor()
  }

  async openReply(): Promise<void> {
    await this.page.keyboard.press('r')
    await this.root.waitFor()
  }

  recipientField(field: RecipientField = 'to'): Locator {
    return this.page.getByTestId(`composer-${field}`)
  }

  chips(field: RecipientField = 'to'): Locator {
    return this.recipientField(field).getByTestId('recipient-chip')
  }

  async addRecipient(address: string, field: RecipientField = 'to'): Promise<void> {
    const input = this.recipientField(field).locator('input')
    await input.fill(address)
    await input.press('Enter')
  }

  /**
   * Retries until the field's chips carry exactly `emails` as their `data-email`.
   * A chip missing the attribute reads as `null` and fails the comparison instead
   * of falling back to display text, so the contract above stays enforced here.
   */
  async expectRecipients(emails: string[], field: RecipientField = 'to'): Promise<void> {
    await expect
      .poll(() =>
        this.chips(field).evaluateAll((chips) => chips.map((chip) => chip.getAttribute('data-email')))
      )
      .toEqual(emails)
  }

  async typeBody(text: string): Promise<void> {
    await this.editor.pressSequentially(text)
  }

  async pickAttachments(): Promise<void> {
    await this.page.getByTestId('composer-attach').click()
  }

  async dropFiles(paths: string[]): Promise<void> {
    const input = this.page.locator('[data-testid="composer-drop-file-input"]')
    await this.page.evaluate(() => {
      const element = document.createElement('input')
      element.type = 'file'
      element.multiple = true
      element.hidden = true
      element.dataset.testid = 'composer-drop-file-input'
      document.body.append(element)
    })
    await input.setInputFiles(paths)
    const dataTransfer = await input.evaluateHandle((element: HTMLInputElement) => {
      const transfer = new DataTransfer()
      for (const file of element.files ?? []) transfer.items.add(file)
      return transfer
    })
    try {
      await this.root.dispatchEvent('drop', { dataTransfer })
    } finally {
      await dataTransfer.dispose()
      await input.evaluate((element) => element.remove())
    }
  }

  async triggerSend(): Promise<void> {
    await this.page.keyboard.press('ControlOrMeta+Enter')
  }

  /** Retries until the header's pending readout settles on `count`. */
  async expectPending(count: number): Promise<void> {
    await expect.poll(() => this.readPending()).toBe(count)
  }

  async expectSaved(): Promise<void> {
    await expect
      .poll(async () => {
        const revisions = await this.readSaveRevisions()
        return revisions.local > this.lastSavedRevision && revisions.saved === revisions.local
      })
      .toBe(true)
    this.lastSavedRevision = (await this.readSaveRevisions()).saved
  }

  private async readSaveRevisions(): Promise<{ local: number; saved: number }> {
    const status = this.page.getByTestId('composer-save-status')
    const [local, saved] = await Promise.all([
      status.getAttribute('data-local-revision'),
      status.getAttribute('data-saved-revision')
    ])
    if (local === null || saved === null) {
      throw new Error(`missing composer revisions: local=${local}, saved=${saved}`)
    }
    const parsed = { local: Number(local), saved: Number(saved) }
    if (!Number.isInteger(parsed.local) || !Number.isInteger(parsed.saved)) {
      throw new Error(`invalid composer revisions: local=${local}, saved=${saved}`)
    }
    return parsed
  }

  private async readPending(): Promise<number> {
    // `evaluateAll` neither waits nor throws on an empty match, which is what
    // makes it safe inside a poll: the retry lives in the assertion above.
    const texts = await this.page
      .getByTestId('pending-count')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
    // The chip renders only above zero, so an absent node is a real zero.
    if (texts.length === 0) return 0
    const pending = /(\d+)\s+pending/.exec(texts[0])
    if (!pending) throw new Error(`pending-count did not read as "<n> pending": ${texts[0]}`)
    return Number(pending[1])
  }
}
