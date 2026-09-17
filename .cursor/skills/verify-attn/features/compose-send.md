# Compose and send

A user writes a new message or a reply, adds recipients, and sends with Mod+Enter. The message waits in the Outbox during the undo window, where Z or the toast's Undo reopens the intact draft. After the window the send goes to Gmail.

## Sub-features

- `compose-new` opens an empty composer with C.
- `compose-reply` opens a reply to the open conversation with R, reply all with A, forward with F.
- `compose-recipients` turns a typed address into a chip with a normalized `data-email`.
- `compose-undo-send` queues the send, shows a countdown toast, and reopens the draft on undo.
- `compose-send` delivers through the send provider once the window passes and drains the Outbox.
- `compose-draft` saves a draft on Escape.

## How to get to it (user POV)

- Press `c` from the list or reader.
- Select `Write` in the top bar.
- Press `r`, `a`, or `f` inside the reader.
- Run `New message`, `Reply all`, `Forward`, or `Discard draft` from the command palette.

## Driving it with a verify-attn drive

Preconditions:

- Seed `fixtures/seed-inbox.json`. `page.getByTestId('thread-list')` is attached.
- `const composer = new ComposerPage(page)` from `e2e/composer`.

- **Open.** Press C. Run `await composer.openNew()`. `composer` is visible and `composer-subject` is empty.
- **Recipients.** Type an address and press Enter. Run `await composer.addRecipient('undo@example.com')`. `await composer.expectRecipients(['undo@example.com'])` passes.
- **Subject and body.** Fill both. Run `await composer.subject.fill('Verify send')` and `await composer.typeBody('Body text')`. The editor contains `Body text`.
- **Send into the undo window.** Press Mod+Enter. Run `await composer.triggerSend()`. `composer` has count 0, `toast` matches `/Sending in \d+ secondsUndo Z/`, and `await composer.expectPending(1)` passes.
- **Undo.** Select Undo on the toast. Run `await page.getByTestId('toast-undo').click()`. `composer` is visible with the same recipients, subject, and body, and `await composer.expectPending(0)` passes.
- **Send through the provider.** Arm the fake provider first. Run `await armSending(app)` from `e2e/seams`, then `await composer.triggerSend()`. `composer` has count 0 and `await composer.expectPending(0)` passes.
- **Draft.** Open a new composer, fill a subject, press Escape. Run `await page.keyboard.press('Escape')`. `toast` reads `Draft saved` and `await composer.expectPending(1)` passes.
- **Proof.** Snapshot the composer, the countdown toast, and the reopened draft. Save the `outbox-count` text before and after with `record()`.

## Gotchas

- Without `armSending(app)` the send sits in the Outbox for the undo window and never reaches a provider. The countdown toast is the proof of that state. Do not wait it out on the wall clock.
- Hidden windows do not dispatch `selectionchange`. To edit at a position, click it and type one character first, then delete through it.
- `expectSaved()` waits for a saved revision newer than the last one it saw. Call it on the same `ComposerPage` instance throughout.
- Whether the fake provider's send appears in the Sent mailbox is not established by this map. Treat an Outbox count of 0 as the delivery proof until a recipe proves the Sent row.
- Chips expose the address in `data-email`. Assert that attribute, not the visible text.
