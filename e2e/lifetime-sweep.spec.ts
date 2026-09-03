import { expect, test } from './electron'
import { oldThread, runSweep } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('resumes a header-only lifetime sweep across offline relaunch without changing inbox unread', async ({
  boot,
  page
}) => {
  const firstThread = oldThread('t-lifetime-2009', 'Archive One <archive.one@example.com>', 2009)
  const oldInboxThread = oldThread(
    't-lifetime-inbox-2010',
    'Archive Inbox <archive.inbox@example.com>',
    2010,
    ['INBOX', 'UNREAD']
  )
  const secondThread = oldThread('t-lifetime-2011', 'Archive Two <archive.two@example.com>', 2011)
  const unreadBefore = await page.evaluate(() => window.attn.mail.getUnreadCount())
  const inboxIdsBefore = await page.evaluate(async () =>
    (await window.attn.mail.listThreadPage('inbox')).rows.map((thread) => thread.id)
  )

  const interrupted = await runSweep(boot.app, {
    resetCursor: 'lifetime',
    threads: [firstThread, oldInboxThread, secondThread],
    pages: [
      {
        threadIds: [firstThread.id, oldInboxThread.id],
        nextPageToken: 'page-2',
        resultSizeEstimate: 11
      }
    ],
    offlineAtPageToken: 'page-2',
    threadsTotal: 11,
    messagesTotal: 13
  })

  expect(interrupted).toEqual({
    cursor: 'lifetime:page-2',
    error: 'offline',
    formats: ['metadata', 'metadata'],
    pageTokens: [undefined, 'page-2']
  })
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(unreadBefore)
  expect(
    await page.evaluate(async () =>
      (await window.attn.mail.listThreadPage('inbox')).rows.map((thread) => thread.id)
    )
  ).toEqual(inboxIdsBefore)
  expect(
    await page.evaluate(() => window.attn.mail.getConversation('t-lifetime-inbox-2010', false, 'normal'))
  ).toMatchObject({ threadId: 't-lifetime-inbox-2010' })
  expect(await page.evaluate(() => window.attn.contacts.search('archive.one'))).toEqual([
    expect.objectContaining({ email: 'archive.one@example.com' })
  ])

  const relaunched = await boot.relaunch()
  const resumed = await runSweep(relaunched.app, {
    threads: [firstThread, oldInboxThread, secondThread],
    pages: [{ pageToken: 'page-2', threadIds: [secondThread.id], resultSizeEstimate: 11 }],
    threadsTotal: 11,
    messagesTotal: 13
  })

  expect(resumed).toEqual({
    cursor: 'done',
    formats: ['metadata'],
    pageTokens: ['page-2']
  })
  expect(await relaunched.page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(unreadBefore)
  expect(
    await relaunched.page.evaluate(async () =>
      (await window.attn.mail.listThreadPage('inbox')).rows.map((thread) => thread.id)
    )
  ).toEqual(inboxIdsBefore)
  expect(
    await relaunched.page.evaluate(() => window.attn.mail.getConversation('t-lifetime-2011', false, 'normal'))
  ).toMatchObject({
    messages: [
      {
        bodyState: 'signed-out',
        bodyText: 'A header-only note to Archive Two <archive.two@example.com>'
      }
    ]
  })
  expect(await relaunched.page.evaluate(() => window.attn.contacts.search('archive.two'))).toEqual([
    expect.objectContaining({ email: 'archive.two@example.com' })
  ])
})
