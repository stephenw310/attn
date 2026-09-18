# Onboarding

Without a signed-in account the app shows the login screen. A development build without an OAuth client keeps Sign in with Google disabled and explains the setup steps.

## Sub-features

- `login-screen` shows the signed-out landing view.
- `login-disabled` keeps the Google button disabled when no OAuth client is configured.
- `login-setup` points at the README setup steps.

## How to get to it (user POV)

- Launch Attn with no accounts signed in.
- For verification, run `launch` with no `--seed`.

## Driving it with control-attn

Preconditions:

- No seed. Run `launch` without `--seed`.

- **Signed-out screen.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs launch
  node .cursor/skills/verify-attn/control-attn.mjs wait login-screen
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('h1')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=login-google]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=login-google]')?.disabled"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=login-setup-message]')?.textContent"
  ```

  The heading is `Your mail, at your pace.` The button text is `Sign in with Google` and it is disabled. The setup message mentions a Google OAuth client and `README.md`.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-login
  ```

- **Sign in.** Not yet driven: needs a real OAuth client, which verification must never read.

## Gotchas

- Do not copy a developer's `oauth.config.json` into the throwaway profile.
- The mail keyboard loop is not mounted on this screen. Inbox shortcuts do nothing here.
