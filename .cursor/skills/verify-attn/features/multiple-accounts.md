# Multiple accounts

A user can sign in more than one Gmail account and switch between them with Mod+1 through Mod+9. Each account keeps its own inbox, drafts, and pending actions.

## Sub-features

- `account-menu` shows the active account email.
- `account-switch` changes the active account with Mod+N.
- `account-status` reports the roster through `window.attn.auth.getStatus()`.

## How to get to it (user POV)

- Launch with the two-accounts seed.
- Press `Mod+1` or `Mod+2` for the account in that order.
- Open the account menu in the header.
- Open Settings, Accounts to add or remove accounts.

## Driving it with control-attn

Preconditions:

- Seed `two-accounts`.

- **Baseline.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs wait thread-list
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.auth.getStatus()"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=account-menu]')?.textContent"
  ```

  Active account is `primary@attn.test`. The menu text contains that address. The roster has two accounts.

- **Switch to the second account.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+2
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.auth.getStatus()"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=account-menu]')?.textContent"
  ```

  `activeAccountId` becomes `second@attn.test` and the menu shows that address.

- **Switch back.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+1
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.auth.getStatus()"
  ```

  `activeAccountId` returns to `primary@attn.test`.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-primary
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-second
  ```

## Gotchas

- Do not put `await` inside an object literal in `eval`. Call `window.attn.auth.getStatus()` as the whole expression. Playwright awaits the returned promise.
- Account order in the menu matches Mod+N order from settings, not alphabetical order.
