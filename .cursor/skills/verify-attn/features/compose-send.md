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

## Driving it with control-attn

Preconditions:

- Seed `inbox`. `wait thread-list` succeeds.

- **Open.** Press C.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs wait thread-list
  node .cursor/skills/verify-attn/control-attn.mjs press c
  node .cursor/skills/verify-attn/control-attn.mjs wait composer
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-subject]')?.value ?? document.querySelector('[data-testid=composer-subject]')?.textContent"
  ```

  `composer` is visible and `composer-subject` is empty.

- **Recipients.** Fill the To field and press Enter. `fill composer-to` finds the nested input when the field is collapsed.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill composer-to undo@example.com
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=recipient-chip]')].map(c => c.getAttribute('data-email'))"
  ```

  The chips are `['undo@example.com']`.

- **Subject and body.** Fill both.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill composer-subject "Verify send"
  node .cursor/skills/verify-attn/control-attn.mjs fill composer-editor "Body text"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-editor]')?.textContent"
  ```

  The editor contains `Body text`.

- **Send into the undo window.** Press Mod+Enter.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=composer]').length"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid toast
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=outbox-count]')?.textContent"
  ```

  `composer` has count 0, `toast` reads `Sending in 5 secondsUndo Z`, and `outbox-count` reads `1 in Outbox`.

- **Undo.** Select Undo on the toast.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs click toast-undo
  node .cursor/skills/verify-attn/control-attn.mjs wait composer
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=recipient-chip]')].map(c => c.getAttribute('data-email'))"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-subject]')?.value"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-editor]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=pending-count]').length"
  ```

  `composer` is visible with the same recipients, subject, and body, and `pending-count` is gone.

- **Send through the provider.** Arm the fake provider first. Both seams need `--fire`.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs seam setUndoSendDelay 0 --fire
  node .cursor/skills/verify-attn/control-attn.mjs seam installSendProvider --fire
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=composer]').length"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=pending-count]').length"
  ```

  `composer` has count 0 and `pending-count` is gone.

- **Draft.** Open a new composer, fill a subject, press Escape.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press c
  node .cursor/skills/verify-attn/control-attn.mjs wait composer
  node .cursor/skills/verify-attn/control-attn.mjs fill composer-subject "Draft subject"
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid toast
  ```

  `toast` reads `Draft saved`.

- **Proof.** Snapshot the composer, the countdown toast, and the reopened draft.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-composer
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-undo-toast
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 03-reopened-draft
  ```

## Gotchas

- Without `seam setUndoSendDelay 0 --fire` and `seam installSendProvider --fire` the send sits in the Outbox for the undo window and never reaches a provider. The countdown toast is the proof of that state. Do not wait it out on the wall clock.
- `seam installSendProvider` without `--fire` can hang. Always pass `--fire` for both send seams.
- Hidden windows do not dispatch `selectionchange`. To edit at a position, click it and type one character first, then delete through it.
- Whether the fake provider's send appears in the Sent mailbox is not established by this map. Treat an Outbox count of 0 as the delivery proof until a recipe proves the Sent row.
- Chips expose the address in `data-email`. Assert that attribute, not the visible text.
