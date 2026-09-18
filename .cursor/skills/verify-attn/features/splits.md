# Split inbox

Split inbox classifies conversations into tabs such as Calendar, GitHub, Important, and Other. A user switches tabs from the strip above the list and opens split rules from the header control.

## Sub-features

- `split-strip` shows the configured tabs with unread counts.
- `split-switch` changes the active tab and the list below it.
- `split-rules` opens the rules editor from the manage control.

## How to get to it (user POV)

- Launch with the splits seed. The strip appears above the Inbox list.
- Choose a tab in the strip.
- Choose the manage control whose tooltip mentions Manage Inbox splits.
- Run split-related commands from the command palette when present.

## Driving it with control-attn

Preconditions:

- Seed `splits`.

- **Baseline.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs wait thread-list
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=split-tab]')].map(el => ({text: el.textContent, id: el.getAttribute('data-split-id'), active: el.getAttribute('data-active')}))"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  ```

  Five tabs are present. Important is active. The list has 1 row.

- **Switch tab.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs click split-tab --text Calendar
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=split-tab]')].find(el => el.getAttribute('data-active') === 'true')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  ```

  Calendar is active and the list shows Calendar conversations.

- **Open rules.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs click split-rules-settings
  node .cursor/skills/verify-attn/control-attn.mjs wait split-rules
  ```

  `split-rules` is visible.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-splits
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-rules
  ```

## Gotchas

- Tab labels include the unread count, for example `Calendar1`. Prefer `--text Calendar` or `data-split-id`.
- The overflow control appears only when tabs are hidden. The splits seed fits without it.
