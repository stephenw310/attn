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

## Driving it with a verify-attn drive

Preconditions:

- Seed `fixtures/seed-inbox.json`. `page.getByTestId('thread-row')` has count 8.
- `page.evaluate(() => window.attn.mail.getUnreadCount())` returns 4.

- **Select.** Press J twice. Run `await page.keyboard.press('j')` twice. `selectedIndex(page)` from `e2e/nav` resolves to 2 and `rows.nth(2)` has `data-unread="true"`.
- **Open.** Press Enter. Run `await page.keyboard.press('Enter')`. `conversation-view` is visible, `thread-list` is hidden, `conversation-subject` reads `Design notes`, and `conversation-view` has `data-thread-index="2"`.
- **Mark read.** Read the store. Run `page.evaluate(() => window.attn.mail.getUnreadCount())` inside `expect.poll`. It resolves to 3 and `pending-count` contains `1 pending`.
- **Next message.** Press J inside the reader. Run `await page.keyboard.press('j')`. `conversation-subject` reads `Lunch next week` and `data-thread-index` is `3`.
- **Back.** Press Escape. Run `await page.keyboard.press('Escape')`. `conversation-view` has count 0, `thread-list` is visible, and `selectedIndex(page)` matches the thread you left.
- **Proof.** Snapshot the list, the reader, and the list after return. Run `snap(page, testInfo, '01-inbox-list')`, `snap(page, testInfo, '02-reader')`, and `snap(page, testInfo, '03-back-to-list')`. Save both unread counts with `record(testInfo, 'unread-count.json', { unreadBefore, unreadAfter })`.

The template drive [../drives/inbox-reading.spec.ts](../drives/inbox-reading.spec.ts) runs this recipe.

## Gotchas

- `firstWindow()` can resolve before the store's first render. Assert the row count of 8 before pressing keys, or J clamps against a one-row list.
- Row 2 (`Your receipt`) is already read in the seed. Opening it does not change the unread count. Use row 3 (`Design notes`) for a mark-read proof.
- `pending-count` renders only above zero. Assert count 0 for "nothing queued", not empty text.
- The footer shortcut hints change between list and reader. `footer-shortcut-reply` exists only in the reader.
