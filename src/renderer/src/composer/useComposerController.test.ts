// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { Draft } from '../../../shared/drafts'
import { subscribeCommandRegistry } from '../commands'
import { ComposerCommandPlugin } from './bodyEditing'
import { useComposerController } from './useComposerController'

// One editor identity for the whole file: the plugin memoizes its `quote`
// handler on the editor, so a fresh object per render would re-register the
// batch for a reason the composer never has in production.
vi.mock('@lexical/react/LexicalComposerContext', () => {
  const context = [{ dispatchCommand: () => false, update: () => {} }]
  return { useLexicalComposerContext: () => context }
})

const draft: Draft = {
  id: 'local-draft',
  accountId: 'user@attn.test',
  kind: 'new',
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  bodyHtml: '',
  bodyText: '',
  attachments: [],
  threadId: null,
  sourceMessageId: null,
  inReplyTo: null,
  references: [],
  quoteHtml: '',
  quoteText: '',
  followUpAt: null,
  createdAt: 1,
  updatedAt: 1
}

// Stable in production too: `Inbox` memoizes both (P2), so a harness that
// recreated them each render would fail for a reason the composer does not own.
const onClose = (): void => {}
const onToast = async (): Promise<void> => {}

type Controller = ReturnType<typeof useComposerController>

async function withComposer(
  run: (controller: () => Controller, registrations: () => number) => Promise<void>
): Promise<void> {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let notifications = 0
  const unsubscribe = subscribeCommandRegistry(() => {
    notifications += 1
  })
  let latest: Controller | undefined
  const root = createRoot(document.createElement('div'))
  function Harness(): React.JSX.Element {
    const controller = useComposerController({
      draft,
      mode: 'full',
      initialError: null,
      onClose,
      onToast,
      supportsAiDraft: false,
      ref: null
    })
    latest = controller
    // Exactly the wiring `Composer.tsx` uses, so the effect's dependency list
    // is exercised with the identities the real composer hands it.
    return createElement(ComposerCommandPlugin, {
      onAttach: controller.pickAttachments,
      onRemoveAttachment: controller.removeLastAttachment,
      onClose: controller.closeAndSave,
      onDiscard: controller.discard,
      onSend: controller.send,
      onFollowUp: controller.openFollowUp
    })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run(
      () => {
        if (!latest) throw new Error('composer controller did not render')
        return latest
      },
      () => notifications
    )
  } finally {
    await act(async () => root.unmount())
    unsubscribe()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous
  }
}

test('keeps the composer command batch registered across subject keystrokes', async () => {
  await withComposer(async (controller, registrations) => {
    const afterMount = registrations()
    expect(afterMount).toBeGreaterThan(0)
    const handlers = controller()

    await act(async () => controller().setSubject('Lunch'))
    expect(controller().subject).toBe('Lunch')
    await act(async () => controller().setSubject('Lunch on Friday'))
    expect(controller().subject).toBe('Lunch on Friday')

    // A re-registration notifies twice (unregister, then register) and pushes
    // a new snapshot at the palette, the footer and the cheat sheet (P2).
    expect(registrations()).toBe(afterMount)
    expect(controller().openFollowUp).toBe(handlers.openFollowUp)
    expect(controller().closeAndSave).toBe(handlers.closeAndSave)
    expect(controller().discard).toBe(handlers.discard)
    expect(controller().send).toBe(handlers.send)
    expect(controller().pickAttachments).toBe(handlers.pickAttachments)
    expect(controller().removeLastAttachment).toBe(handlers.removeLastAttachment)
  })
})

test('opens the follow-up popover through the stable handler', async () => {
  await withComposer(async (controller) => {
    expect(controller().followUpOpen).toBe(false)
    await act(async () => controller().openFollowUp())
    expect(controller().followUpOpen).toBe(true)
  })
})
