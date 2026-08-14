import type { Locator, Page } from '@playwright/test'

export type RecipientField = 'to' | 'cc' | 'bcc'

export interface OutboxReadout {
  pending: number
  text: string
}

/**
 * Declarative driver shared by the composer, draft, send, and attachment suites.
 *
 * Recipient chips expose their normalized address as `data-email`; their visible
 * text remains free to include the display name. Keeping that contract here lets
 * specs assert reply planning without knowing the composer's DOM structure.
 */
export class ComposerPage {
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

  async openNew(): Promise<void> {
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

  async addRecipient(address: string, field: RecipientField = 'to'): Promise<void> {
    const input = this.recipientField(field).locator('input')
    await input.fill(address)
    await input.press('Enter')
  }

  async recipientChips(field: RecipientField = 'to'): Promise<string[]> {
    return this.recipientField(field)
      .getByTestId('recipient-chip')
      .evaluateAll((chips) =>
        chips.map((chip) => chip.getAttribute('data-email') ?? chip.textContent?.trim() ?? '')
      )
  }

  async typeBody(text: string): Promise<void> {
    await this.editor.pressSequentially(text)
  }

  async triggerSend(): Promise<void> {
    await this.page.keyboard.press('ControlOrMeta+Enter')
  }

  async readOutbox(): Promise<OutboxReadout> {
    const text = (await this.page.getByTestId('queue-readout').innerText()).trim()
    const pending = Number(/(\d+)\s+pending/.exec(text)?.[1] ?? 0)
    return { pending, text }
  }
}
