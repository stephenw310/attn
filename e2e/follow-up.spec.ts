import type { ElectronApplication, Page } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

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

async function emitSeam(app: ElectronApplication, channel: string, request?: unknown): Promise<void> {
  const error = await app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(input.channel, {}, input.request, resolve)),
    { channel, request }
  )
  if (error) throw new Error(error)
}

async function armSending(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => ipcMain.emit(channel, {}, 0), TEST_CHANNELS.setUndoSendDelay)
  await emitSeam(app, TEST_CHANNELS.installSendProvider)
}

function designRow(page: Page) {
  return page.getByTestId('thread-row').filter({ hasText: 'Design notes' })
}

/** Reply to the design-notes thread with a follow-up deadline, then send it. */
async function sendReplyWithFollowUp(page: Page, deadline: string): Promise<void> {
  await designRow(page).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.typeBody('Circling back on this.')
  await page.getByTestId('composer-follow-up').click()
  await page.getByTestId('follow-up-custom-input').fill(deadline)
  await expect(page.getByTestId('follow-up-resolved')).not.toContainText('Pick a future time')
  await page.getByTestId('follow-up-custom-confirm').click()
  await expect(page.getByTestId('composer-follow-up')).toContainText('Follow up')
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
    designRow(page).getByTestId('chip-follow-up-due'),
    'the pending follow-up lists in the Reminders view'
  ).toBeVisible()
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
  const returned = designRow(page)
  await expect(returned.getByTestId('chip-follow-up')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('thread-row').first()).toContainText('Design notes')
  await expect(page.getByTestId('thread-date-group').first()).toHaveText('Follow up')

  // Opening it does not clear the chip — reading is not answering.
  await returned.click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  await page.keyboard.press('Escape')
  await expect(designRow(page).getByTestId('chip-follow-up')).toBeVisible()

  // Archive completes it: the thread leaves the inbox and stays gone.
  await page.keyboard.press('e')
  await expect(designRow(page)).toHaveCount(0)
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
  await expect(designRow(page).getByTestId('chip-follow-up')).toHaveCount(0)
})

test('a reply during snooze wakes the thread with its Returned chip (GAP-1)', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const row = designRow(page)
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
  await sendReplyWithFollowUp(page, 'in 2 seconds')
  // Snooze before the follow-up fires: the pending snooze postpones it.
  await page.evaluate(() => window.attn.mail.snooze(['t-design'], Date.now() + 1_200))
  await expect(designRow(page)).toHaveCount(0)

  // Both deadlines pass while the app is closed; startup settles them once.
  const { page: relaunched } = await boot.relaunch({ waitBeforeLaunch: 2_500 })
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
