import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'
import { armSending, emitSeam, expireReminders } from './seams'

// T35 (F9): follow-up reminders end to end — the composer deadline, the
// reminder created at the sent transition through the production OutboxSender
// (send seam), reply cancellation through the production history cycle, the
// snooze interplay, and GAP-1's reply-wakes-snooze assertion. Zero Gmail.
//
// These tests reply on the 'Design notes' thread because its seeded messages
// are day-anchored to yesterday: a sent origin stamped "now" always postdates
// them, whatever the wall-clock time of the run. The roadmap thread's
// same-day morning stamps can land in the test's future, which would make
// pre-existing mail wrongly qualify as replies.

test.use({ seed: 'fixtures/seed-inbox.json' })

/** Reply to the design-notes thread with a follow-up deadline, then send it. */
async function sendReplyWithFollowUp(page: Page, deadline: string): Promise<void> {
  await threadRow(page, 'Design notes').click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const composer = new ComposerPage(page)
  await composer.openReply()
  const followUpTrigger = page.getByTestId('composer-follow-up')
  await expect(followUpTrigger).not.toContainText('⏰')
  await expect(followUpTrigger).toHaveAttribute('aria-label', 'Remind me if no reply')
  await composer.typeBody('Circling back on this.')
  await page.getByTestId('composer-follow-up').click()
  await page.getByTestId('follow-up-custom-input').fill(deadline)
  await expect(page.getByTestId('follow-up-resolved')).not.toContainText('Pick a future time')
  await page.getByTestId('follow-up-custom-confirm').click()
  await expect(followUpTrigger).toHaveAttribute('data-follow-up-at', /\d+/)
  await composer.triggerSend()
  await expect(composer.root).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
}

/** The Snoozed/Reminders view row for the design-notes thread. */
async function expectReminderListed(page: Page): Promise<void> {
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(
    threadRow(page, 'Design notes').getByTestId('chip-follow-up-due'),
    'the pending follow-up lists in the Reminders view'
  ).toBeVisible()
  await threadRow(page, 'Design notes').click()
  await expect(page.getByTestId('conversation-follow-up')).toContainText('Follow up')
  await expect(page.getByTestId('conversation-follow-up-banner')).toContainText('if no one replies')
  await expect(page.getByTestId('conversation-snooze-banner')).toHaveCount(0)
  mkdirSync('e2e/.artifacts', { recursive: true })
  await page.screenshot({ path: 'e2e/.artifacts/reader-follow-up-pending.png' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('i')
}

function replySnapshot(internalDate: number): GmailThread {
  return {
    id: 't-design',
    messages: [
      {
        id: 'm-design-reply',
        threadId: 't-design',
        labelIds: ['INBOX', 'UNREAD'],
        internalDate: String(internalDate),
        snippet: 'Sounds good, talk then.',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Theo Park <theo@example.com>' },
            { name: 'Subject', value: 'Re: Design notes' },
            { name: 'Message-ID', value: '<design-reply@example.com>' }
          ]
        }
      }
    ]
  }
}

test('a due follow-up resurfaces above normal mail with its chip, and archive completes it', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await armSending(app)
  await sendReplyWithFollowUp(page, 'in 2 seconds')

  // The reminder resurfaces the thread at the top under its own heading.
  const returned = threadRow(page, 'Design notes')
  await expect(returned.getByTestId('chip-follow-up')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('thread-row').first()).toContainText('Design notes')
  await expect(page.getByTestId('thread-date-group').first()).toHaveText('Follow up')

  // Opening it does not clear the chip — reading is not answering.
  await returned.click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  await expect(page.getByTestId('conversation-follow-up-banner')).toHaveText(
    'No reply yet. This conversation returned for follow-up.'
  )
  mkdirSync('e2e/.artifacts', { recursive: true })
  await page.screenshot({ path: 'e2e/.artifacts/reader-follow-up-returned.png' })
  await page.keyboard.press('Escape')
  await expect(threadRow(page, 'Design notes').getByTestId('chip-follow-up')).toBeVisible()

  // Archive completes it: the thread leaves the inbox and stays gone.
  await page.keyboard.press('e')
  await expect(threadRow(page, 'Design notes')).toHaveCount(0)
})

test('the originating send never cancels; a real reply does, before the deadline', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await armSending(app)
  await sendReplyWithFollowUp(page, 'in 2 hours')
  await expectReminderListed(page)

  // Replaying the originating sent message through the production history
  // cycle must not cancel the reminder (F9).
  await emitSeam(app, TEST_CHANNELS.runHistoryCycle, {
    records: [
      {
        id: '2',
        messagesAdded: [{ message: { id: 'test-sent-2', threadId: 't-design', labelIds: ['SENT'] } }]
      }
    ]
  })
  await expectReminderListed(page)

  // A later inbound reply cancels it: the reminder leaves the view and the
  // thread never resurfaces.
  await emitSeam(app, TEST_CHANNELS.runHistoryCycle, {
    records: [
      {
        id: '3',
        messagesAdded: [
          { message: { id: 'm-design-reply', threadId: 't-design', labelIds: ['INBOX', 'UNREAD'] } }
        ]
      }
    ],
    threads: [replySnapshot(Date.now())]
  })
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByTestId('chip-follow-up-due')).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(threadRow(page, 'Design notes').getByTestId('chip-follow-up')).toHaveCount(0)
})

test('the shortcut opens follow-up without overflowing the toolbar, and Escape restores focus', async ({
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await threadRow(page, 'Design notes').click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const composer = new ComposerPage(page)
  await composer.openReply()

  // The command has a discoverable shortcut and moves focus into the
  // popover, so its Escape containment sees the key.
  await page.keyboard.press('ControlOrMeta+Shift+H')
  const popover = page.getByTestId('follow-up-popover')
  await expect(popover).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null))
    .toBe('follow-up-popover')

  await page.getByTestId('follow-up-preset-3d').click()
  await expect(popover).toHaveCount(0)
  await expect(page.getByTestId('composer-follow-up')).toHaveAttribute('data-follow-up-at', /\d+/)
  await expect
    .poll(() =>
      page.getByTestId('composer-footer').evaluate((footer) => footer.scrollWidth <= footer.clientWidth)
    )
    .toBe(true)

  await page.keyboard.press('ControlOrMeta+Shift+H')
  await expect(popover).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(composer.root).toBeVisible()

  // Dismissal hands focus back to the trigger; the next Escape is the
  // composer's ordinary close.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null))
    .toBe('composer-follow-up')
  await page.keyboard.press('Escape')
  await expect(composer.root).toHaveCount(0)
})

test('a reply during snooze wakes the thread with its Returned chip (GAP-1)', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const row = threadRow(page, 'Design notes')
  await row.click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  await page.keyboard.press('Escape')
  // Snooze far out so only the wake can return it.
  await page.evaluate(() => window.attn.mail.snooze(['t-design'], Date.now() + 60 * 60 * 1000))
  await expect(row).toHaveCount(0)

  await emitSeam(app, TEST_CHANNELS.runHistoryCycle, {
    records: [
      {
        id: '2',
        messagesAdded: [
          { message: { id: 'm-design-reply', threadId: 't-design', labelIds: ['INBOX', 'UNREAD'] } }
        ]
      }
    ],
    threads: [replySnapshot(Date.now())]
  })
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('chip-returned')).toBeVisible()
})

test('coexisting snooze and follow-up produce one stable return across relaunch', async ({
  app,
  boot,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await armSending(app)
  await sendReplyWithFollowUp(page, 'in 2 hours')
  // Snooze before the follow-up fires, and ahead of its deadline: the pending
  // snooze postpones it.
  await page.evaluate(() => window.attn.mail.snooze(['t-design'], Date.now() + 60 * 60 * 1_000))
  await expect(threadRow(page, 'Design notes')).toHaveCount(0)

  // Both deadlines pass while the app is closed; startup settles them once.
  // Neither can be written already due through the bridge: its snooze call
  // refreshes the scheduler, so a past deadline would return the thread while
  // the app is still up. The seam back-dates both stored deadlines instead,
  // keeping the snooze ahead of the follow-up, and waits for the send to have
  // written its reminder — two pending rows — before it does.
  await expect.poll(() => expireReminders(app, 2)).toBe(2)
  const { page: relaunched } = await boot.relaunch()
  const returned = relaunched.getByTestId('thread-row').filter({ hasText: 'Design notes' })
  await expect(returned.getByTestId('chip-follow-up')).toBeVisible({ timeout: 10_000 })
  await expect(returned.getByTestId('chip-returned')).toBeVisible()
  await expect(relaunched.getByTestId('thread-date-group').first()).toHaveText('Follow up')

  // A view round trip re-reads from SQLite: the return remains visible.
  await relaunched.keyboard.press('g')
  await relaunched.keyboard.press('a')
  await relaunched.keyboard.press('g')
  await relaunched.keyboard.press('i')
  await expect(returned.getByTestId('chip-follow-up')).toBeVisible()
})

test('cancels a follow-up from the reader and palette, with undo', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await armSending(app)
  await sendReplyWithFollowUp(page, 'in 2 hours')
  await expectReminderListed(page)
  await threadRow(page, 'Design notes').click()
  await page.getByTestId('conversation-cancel-follow-up').click()
  await expect(page.getByTestId('conversation-follow-up-banner')).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(page.getByTestId('conversation-cancel-follow-up')).toBeVisible()
  await runPaletteCommand(page, 'Cancel follow-up')
  await expect(page.getByTestId('conversation-follow-up-banner')).toHaveCount(0)
})
