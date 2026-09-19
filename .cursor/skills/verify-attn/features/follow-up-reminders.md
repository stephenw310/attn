# Follow-up reminders

A user sets a follow-up deadline on a reply from the composer. After send, the conversation appears in the Snoozed and reminders view with a follow-up chip until someone replies or the user completes it.

## Sub-features

- `follow-open` opens the follow-up picker from the composer control.
- `follow-set` resolves a natural-language deadline and stores it on the draft.
- `follow-pending` lists the sent conversation under reminders with `chip-follow-up-due`.
- `follow-due` resurfaces a due follow-up in the Inbox.

## How to get to it (user POV)

- Open a reply, choose `Remind me if no reply` on the composer, enter a deadline, and send.
- Press `g` then `h` to open the Snoozed and reminders view.
- Run `Cancel follow-up` from the command palette when a follow-up is active.

## Driving it with control-attn

Preconditions:

- Seed `inbox`. Arm sending with `seam setUndoSendDelay 0 --fire` and `seam installSendProvider --fire`.
- Open the Design notes conversation (press J twice, then Enter).

- **Open reply and follow-up.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press r
  node .cursor/skills/verify-attn/control-attn.mjs wait composer
  node .cursor/skills/verify-attn/control-attn.mjs click composer-follow-up
  node .cursor/skills/verify-attn/control-attn.mjs wait follow-up-custom-input
  ```

  The custom deadline field is visible.

- **Set deadline.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill follow-up-custom-input "in 2 hours"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=follow-up-resolved]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs click follow-up-custom-confirm
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-follow-up]')?.getAttribute('data-follow-up-at')"
  ```

  `follow-up-resolved` shows a future clock time. `data-follow-up-at` is a millisecond timestamp.

- **Send and open reminders.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+Enter
  node .cursor/skills/verify-attn/control-attn.mjs press g
  node .cursor/skills/verify-attn/control-attn.mjs press h
  node .cursor/skills/verify-attn/control-attn.mjs wait view-title
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=view-title]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=chip-follow-up-due]') !== null"
  ```

  `view-title` reads `Snoozed` and `chip-follow-up-due` is present.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-follow-up-set
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-reminders
  ```

- **Due resurface.** Not yet driven: needs `seam expireReminders` and a relaunch, and `close` deletes the profile.

## Gotchas

- Follow-up lives on the composer, not the list. Open a reply first.
- The reminders view shares the `g h` chord with Snoozed. The title still reads `Snoozed`.
- Enabling AI or send seams is setup. The chip and title are the proof.
