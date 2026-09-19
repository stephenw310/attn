# Security policy

Attn stores Gmail OAuth tokens and cached mail on your computer. It also sends mail from your account. Report a suspected vulnerability in private.

## Report a vulnerability

1. Open the [Security tab](https://github.com/stephenw310/attn/security) of this repository.
2. Select **Report a vulnerability**.
3. Describe the problem, the affected version or commit, and the steps to reproduce it.

Do not open a public issue for a vulnerability. Do not include real mail content, addresses, tokens, or API keys in the report.

Expect a first reply within seven days. Attn is a small project without a paid bounty.

## Supported versions

Attn is in early development. Security fixes go to the `main` branch and the latest release only.

## In scope

- Script execution or sandbox escape from mail HTML or attachments.
- Access to OAuth tokens or AI provider keys by another account, another process boundary, or a mail sender.
- Mail data that crosses between signed-in accounts.
- A remote image, link, or update feed that bypasses the checks in the main process.
- An IPC channel that accepts unvalidated arguments from the renderer.

## Out of scope

- An attacker who already controls your operating system account. Attn does not encrypt the mail database. See [Data and privacy](README.md#data-and-privacy).
- Your own Google OAuth client, its consent screen, and its quota.
- Data that you send to an AI provider or to TypeSafe after you enable those features.
- Unsigned personal builds that trigger operating system warnings.
