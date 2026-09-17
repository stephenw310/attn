# Search

Search filters cached mail as the user types and supports Gmail operators such as `from:` and `has:attachment`. Enter moves focus to the results. When local results may be incomplete, a status offers to search all of Gmail. Leaving search restores the mailbox and its selection.

## Sub-features

- `search-open` focuses the search input from the keyboard or the toolbar.
- `search-local` filters rows as typed against the local store.
- `search-operators` accepts `from:`, `has:attachment`, `after:`, and `in:` operators.
- `search-open-result` opens a result in the reader and returns to the results on Escape.
- `search-restore` returns to the previous mailbox and selection after the last Escape.
- `search-remote` offers `Press Enter to search all of Gmail` and merges remote results under `More from Gmail`.

## How to get to it (user POV)

- Press `/` while the list is focused.
- Select the search control in the top bar (`search-open`).
- Run `Search mail` from the command palette.

## Driving it with a verify-attn drive

Preconditions:

- Seed `fixtures/seed-search.json`. It contains `t-search-acme` (`Acme annual roadmap`) and mapped remote queries.
- The first row is selected. Save its `data-thread-id` before you start.

- **Open.** Press slash. Run `await page.keyboard.press('/')`. `search-input` is focused.
- **Local match.** Type a partial sender. Run `await input.fill('from:ac')`. The row with `data-thread-id="t-search-acme"` is visible.
- **Operators.** Combine operators. Run `await input.fill('from:acme.com has:attachment after:2026-01-01')`. `thread-list` has `data-thread-count="1"` and `search-coverage` has `data-search-query` equal to the typed text.
- **Open result.** Press Enter twice. Run `await input.press('Enter')` then `await page.keyboard.press('Enter')`. `thread-list` was focused between the presses, then `conversation-subject` reads `Acme annual roadmap`.
- **Return.** Press Escape three times. Run `await page.keyboard.press('Escape')` three times. First the list is focused, then `search-input` is focused with the query intact, then `view-title` reads `Inbox` and the originally selected `data-thread-id` is selected again.
- **Remote prompt.** Open search and type a term with no local match. Run `await page.getByTestId('search-open').click()` and `await input.fill('serveronlyneedle')`. `thread-list` has `data-thread-count="0"` and `search-all-gmail` reads `Press Enter to search all of Gmail` with role `status`.
- **Remote results.** Press Enter. Run `await input.press('Enter')`. `thread-section-divider` reads `More from Gmail` and the row `t-search-server-only` is visible.
- **Proof.** Snapshot the filtered list, the reader, and the remote results. Save the `data-search-query` and `data-thread-count` attributes with `record()`.

## Gotchas

- Pressing `/` while an input has focus types a slash. Focus the list first.
- Remote queries resolve only when the fixture's `remoteSearches` maps the exact translated query. An unmapped query returns no remote rows. That is fixture behavior, not a defect.
- `TEST_CHANNELS.setSearchWindow` shrinks the local window to force `data-partial="true"`. It sets up the scenario. The coverage attribute is the proof.
- Reading a result marks it read. A second run in the same instance sees a different unread state.
