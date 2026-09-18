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

## Driving it with control-attn

Preconditions:

- Seed `search`. It contains `t-search-acme` (`Acme annual roadmap`) and mapped remote queries.
- The first row is selected. Save its `data-thread-id` before you start.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs launch --seed search
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row][data-selected]')?.getAttribute('data-thread-id')"
  ```

- **Open.** Press slash.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press /
  node .cursor/skills/verify-attn/control-attn.mjs wait search-input
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.activeElement?.getAttribute('data-testid')"
  ```

  `search-input` is focused.

- **Local match.** Type a partial sender.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill search-input from:ac
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-thread-id=\"t-search-acme\"]') !== null"
  ```

  The row with `data-thread-id="t-search-acme"` is visible.

- **Operators.** Combine operators.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill search-input "from:acme.com has:attachment after:2026-01-01"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-list]')?.getAttribute('data-thread-count')"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=search-coverage]')?.getAttribute('data-search-query')"
  ```

  `thread-list` has `data-thread-count="1"` and `search-coverage` has `data-search-query` equal to the typed text.

- **Open result.** Press Enter twice.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs wait conversation-view
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid conversation-subject
  ```

  `thread-list` was focused between the presses, then `conversation-subject` reads `Acme annual roadmap`.

- **Return.** Press Escape three times.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=view-title]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row][data-selected]')?.getAttribute('data-thread-id')"
  ```

  First the list is focused, then `search-input` is focused with the query intact, then `view-title` reads `Inbox` and the originally selected `data-thread-id` is selected again.

- **Remote prompt.** Open search and type a term with no local match.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs click search-open
  node .cursor/skills/verify-attn/control-attn.mjs fill search-input serveronlyneedle
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-list]')?.getAttribute('data-thread-count')"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid search-all-gmail
  ```

  `thread-list` has `data-thread-count="0"` and `search-all-gmail` reads `Press Enter to search all of Gmail` with role `status`.

- **Remote results.** Press Enter.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid thread-section-divider
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-thread-id=\"t-search-server-only\"]') !== null"
  ```

  `thread-section-divider` reads `More from Gmail` and the row `t-search-server-only` is visible.

- **Proof.** Snapshot the filtered list, the reader, and the remote results. Save the `data-search-query` and `data-thread-count` attributes.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-filtered
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-reader
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 03-remote
  ```

## Gotchas

- Pressing `/` while an input has focus types a slash. Focus the list first.
- Remote queries resolve only when the fixture's `remoteSearches` maps the exact translated query. An unmapped query returns no remote rows. That is fixture behavior, not a defect.
- `seam setSearchWindow` shrinks the local window to force `data-partial="true"`. It sets up the scenario. The coverage attribute is the proof.
- Reading a result marks it read. A second run in the same instance sees a different unread state.
