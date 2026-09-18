# AI drafting

Optional AI reply drafting streams text into the reply composer when the user presses Mod+J. Verification uses a fake provider and a key stored through the bridge. No real AI endpoint is called.

## Sub-features

- `ai-enable` turns AI on through the bridge for the throwaway profile.
- `ai-fake` installs the scripted fake provider.
- `ai-draft` opens a reply composer and streams the scripted chunks into the editor.

## How to get to it (user POV)

- Enable AI writing in Settings, or set the key and enabled flag through the bridge in a verification run.
- Open a conversation and press `Mod+J`.
- Run AI commands from the command palette when AI is enabled.

## Driving it with control-attn

Preconditions:

- Seed `inbox`.

- **Enable AI and install the fake provider.** These calls are setup, not proof.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.ai.setKey('sk-e2e-test')"
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.ai.setSetting('enabled', true)"
  node .cursor/skills/verify-attn/control-attn.mjs seam installFakeAiProvider '{"chunks":["Thanks for the notes."," I will review today."]}' --fire
  ```

- **Open Design notes and draft.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press j
  node .cursor/skills/verify-attn/control-attn.mjs press j
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs wait conversation-view
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=conversation-subject]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+j
  ```

  Wait until the composer appears, then read the editor.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs wait composer
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=composer-editor]')?.textContent"
  ```

  The subject is `Design notes`. The editor contains `Thanks for the notes. I will review today.` plus the Attn send footer.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-ai-draft
  ```

## Gotchas

- Bridge `setKey` and `setSetting` are setup. Proof is the streamed editor text after Mod+J.
- Pass `--fire` on `installFakeAiProvider`. Without it the seam can hang.
- Inline autocomplete is a separate opt-in and is not covered here.
- The editor text includes `Sent with Attn`. Assert the generated phrase, not an exact full-string match, if the footer changes.
