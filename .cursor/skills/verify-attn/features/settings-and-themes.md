# Settings and themes

Settings is a full-screen view opened with Mod+,. Appearance, triage, notifications, privacy, background, AI, snippets, and about live in its left nav. Themes also change from the command palette.

## Sub-features

- `settings-open` opens settings with Mod+, and shows `settings-view`.
- `settings-nav` switches sections from the left nav.
- `theme-palette` switches Dark, Light, or System from the command palette.
- `settings-back` returns to mail with Escape or the back control.

## How to get to it (user POV)

- Press `Mod+,`.
- Run `Use Dark theme`, `Use Light theme`, or `Use System theme` from the command palette.
- Choose Back to mail or press Escape.

## Driving it with control-attn

Preconditions:

- Seed `inbox`.

- **Theme from the palette.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+K
  node .cursor/skills/verify-attn/control-attn.mjs wait command-palette
  node .cursor/skills/verify-attn/control-attn.mjs fill command-palette-input "Use Light theme"
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.documentElement.getAttribute('data-theme')"
  ```

  `data-theme` becomes `dispatch-light`.

- **Open settings.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+,
  node .cursor/skills/verify-attn/control-attn.mjs wait settings-view
  ```

  `settings-view` is visible with nav entries such as Appearance and Accounts.

- **Appearance nav.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs click settings-nav-appearance
  ```

  The Appearance section is selected.

- **Back.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs wait thread-list
  ```

  The Inbox list returns.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-light-theme
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-settings
  ```

## Gotchas

- Settings is not a dialog role. Wait for `settings-view`, not `[role=dialog]`.
- The e2e fixture defaults to dark. A Light theme run is a visible change against that baseline.
