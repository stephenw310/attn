# Inbox list and reader

The Inbox lists conversations grouped by age. A user moves the selection with J and K, opens the selected conversation with Enter, reads its messages, and returns to the list with Esc or Back. Opening a conversation marks it read and queues that change for Gmail.

## Sub-features

- `read-select` moves the selection with J, K, ArrowDown, and ArrowUp and clamps at both ends.
- `read-open` opens the selected conversation and hides the list.
- `read-mark` marks the opened conversation read in the store and clears its unread marker.
- `read-next` moves to the next or previous conversation from inside the reader with J and K.
- `read-back` returns to the list with Esc, K past the first message, or the Back control, and keeps the selection.

## How to get to it (user POV)

- Launch the app while signed in. The Inbox list is the first screen.
- Press `g` then `i` from any mailbox to return to the Inbox.
- Run `Go to Inbox` from the command palette.

## Driving it with control-attn

Preconditions:

- Seed `inbox`. `eval "document.querySelectorAll('[data-testid=thread-row]').length"` returns 8.
- `eval "window.attn.mail.getUnreadCount()"` returns 4.

- **Select.** Press J twice.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press j
  node .cursor/skills/verify-attn/control-attn.mjs press j
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=thread-row]')].findIndex(r => r.hasAttribute('data-selected'))"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]')[2]?.getAttribute('data-unread')"
  ```

  The selected index is 2 and that row has `data-unread="true"`.

- **Open.** Press Enter.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs wait conversation-view
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid conversation-subject
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=conversation-view]')?.getAttribute('data-thread-index')"
  ```

  `conversation-view` is visible, `thread-list` is hidden, the subject snapshot contains `Design notes`, and `data-thread-index` is `2`.

- **Mark read.** Read the store.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.mail.getUnreadCount()"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid pending-count
  ```

  Unread count is 3 and `pending-count` contains `1 pending`.

- **Next message.** Press J inside the reader.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press j
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid conversation-subject
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=conversation-view]')?.getAttribute('data-thread-index')"
  ```

  The subject snapshot contains `Lunch next week` and `data-thread-index` is `3`.

- **Back.** Press Escape.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs wait thread-list
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=thread-row]')].findIndex(r => r.hasAttribute('data-selected'))"
  ```

  `conversation-view` is gone, `thread-list` is visible, and the selected index matches the thread you left.

- **Proof.** Snapshot the list, the reader, and the list after return.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-inbox-list
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-reader
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 03-back-to-list
  ```

  Save both unread counts from the `eval` results.

## Gotchas

- `launch` can return before the store's first render. Assert the row count of 8 before pressing keys, or J clamps against a one-row list.
- Row 2 (`Your receipt`) is already read in the seed. Opening it does not change the unread count. Use row 3 (`Design notes`) for a mark-read proof.
- `pending-count` renders only above zero. Assert count 0 for "nothing queued", not empty text.
- The footer shortcut hints change between list and reader. `footer-shortcut-reply` exists only in the reader.
