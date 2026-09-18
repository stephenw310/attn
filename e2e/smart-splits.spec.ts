import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { emitSeam, flushRendererIpc, installFakeTriage, runTriagePass, triageRequests } from './seams'

test.use({ seed: 'fixtures/seed-splits.json' })

// Phase 3/4 end to end: a described split, the shipped classifier pass, and
// the request bodies that actually left the process. The scripted TypeSafe
// service answers by subject, so the spec states which conversation belongs in
// the described split and then checks that the Inbox agrees.

const DESCRIPTION = 'Personal invitations to meet up in person'

/** The complete state contract. Anything else here would be an F17 leak. */
const ALLOWED_STATE_KEYS = [
  'subject',
  'sender',
  'recipient_count',
  'gmail_categories',
  'mailing_list',
  'message_count',
  'first_message',
  'latest_message'
]

test('classifies a described split and sends only the disclosed state', async ({ app, page }) => {
  const strip = page.getByTestId('split-strip')
  const rows = page.getByTestId('thread-row')
  await expect(strip).toBeVisible()

  await installFakeTriage(app, {
    default: 0.05,
    bySubject: [{ subjectIncludes: 'Dinner Friday', probabilities: { Dinners: 0.94 } }]
  })

  // Consent and the key go through the shipped bridge, not a test back door.
  await page.evaluate(async () => {
    await window.attn.ai.setTriageKey('ts-test-key-e2e')
    await window.attn.ai.setSetting('triageEnabled', true)
  })
  await page.evaluate(async (description) => {
    await window.attn.splits.save({
      name: 'Dinners',
      operator: 'any',
      conditions: [{ type: 'description', value: description }],
      notify: false
    })
  }, DESCRIPTION)

  await runTriagePass(app)

  const dinners = page.locator('[data-testid="split-tab"][data-split-id^="custom:"]')
  await expect(dinners).toHaveText(/Dinners1/)
  await dinners.click()
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Dinner Friday?')

  // The described split took the thread out of Other; the rest stays put.
  await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Weekend walk')

  const requests = await triageRequests(app)
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) {
    for (const key of Object.keys(request.state)) expect(ALLOWED_STATE_KEYS).toContain(key)
    const messages = [request.state.first_message, request.state.latest_message].filter(Boolean) as {
      from: string
      excerpt: string
    }[]
    for (const message of messages) {
      expect(Object.keys(message).sort()).toEqual(['excerpt', 'from'])
      expect(message.excerpt.length).toBeLessThanOrEqual(1_500)
      expect(message.excerpt).not.toContain('<')
    }
    // One question per described split, asking about the user's own words.
    expect(Object.keys(request.questions)).toEqual(['s0'])
    expect(JSON.stringify(request.questions.s0?.criteria)).toContain(DESCRIPTION)
  }
})

test('writes a description in the rule editor and links to the consent it needs', async ({
  app,
  page
}, testInfo) => {
  await page.getByTestId('split-rules-settings').click()
  await expect(page.getByTestId('split-rules')).toBeVisible()
  await page.getByTestId('split-rule-new').click()
  await page.getByTestId('split-rule-name').fill('Landlord')
  await page.getByLabel('Condition 1 type').selectOption({ label: 'Matches description' })

  const description = page.getByTestId('split-rule-description')
  await expect(description).toBeVisible()
  await description.fill('Anything from my landlord, such as a rent receipt or a repair notice')

  // The rule is savable, but nothing judges it yet: the editor says so and
  // offers the one setting that fixes it.
  const off = page.getByTestId('split-rule-triage-off')
  await expect(off).toBeVisible()
  await expect(off).toContainText('Smart splits are off')

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const editorPath = join(artifactDirectory, 'split-rule-description.png')
  await page.screenshot({ path: editorPath, animations: 'disabled' })
  await testInfo.attach('split-rule-description', { path: editorPath, contentType: 'image/png' })

  await page.getByTestId('split-rule-save').click()
  const saved = page.locator('[data-testid="split-rule"][data-split-id^="custom:"]')
  await expect(saved).toHaveCount(1)
  await expect(saved.getByTestId('split-rule-summary')).toContainText('Landlord')
  await expect(saved.getByTestId('split-rule-summary')).toContainText('1 condition')

  // The note's button is the `ai.triageSettings` path: it closes the manager
  // and opens Settings on the smart-splits controls.
  await saved.getByTestId('split-rule-summary').click()
  await page.getByTestId('split-rule-triage-setup').click()
  await expect(page.getByTestId('split-rules')).toHaveCount(0)
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByTestId('settings-ai-triage-enabled')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)

  // Consent and the key arrive through the shipped bridge. The manager reads
  // them when it opens, so the note clears on the next open, not in place.
  await installFakeTriage(app, { default: 0.05 })
  await page.evaluate(async () => {
    await window.attn.ai.setTriageKey('ts-test-key-editor')
    await window.attn.ai.setSetting('triageEnabled', true)
  })

  await page.getByTestId('split-rules-settings').click()
  await expect(page.getByTestId('split-rules')).toBeVisible()
  await saved.getByTestId('split-rule-summary').click()
  await expect(page.getByTestId('split-rule-description')).toBeVisible()
  await expect(page.getByTestId('split-rule-triage-off')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Smart splits meet notifications (F17 × F12). A described split that notifies
// cannot decide before its judgment, so an arrival either waits for the answer
// inside `SPLIT_TRIAGE_NOTIFY_WAIT_MS` or is announced by the judgment that
// lands after the wait — once, never twice.
// ---------------------------------------------------------------------------

const ACCOUNT = 'splits@attn.test'
const INVITES = 'Personal invitations to meet up in person'
const ARRIVING_SUBJECT = 'Rooftop drinks on Thursday?'

/** The arriving conversation: Inbox, unread, no IMPORTANT label, no list id. */
function arrival(): GmailThread {
  return {
    id: 't-rooftop',
    messages: [
      {
        id: 'm-rooftop',
        threadId: 't-rooftop',
        labelIds: ['INBOX', 'UNREAD'],
        internalDate: String(Date.now()),
        snippet: 'Come by at seven if you are free.',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Nina Patel <nina@example.com>' },
            { name: 'To', value: ACCOUNT },
            { name: 'Subject', value: ARRIVING_SUBJECT },
            { name: 'Message-ID', value: '<rooftop@example.com>' }
          ]
        }
      }
    ]
  }
}

/**
 * Deliver that conversation through the production history cycle, announced
 * the way the poller announces a cycle's arrivals — which is what asks for a
 * notification decision.
 */
function deliverArrival(app: ElectronApplication): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.runHistoryCycle, {
    announce: true,
    records: [
      {
        id: '2',
        messagesAdded: [
          { message: { id: 'm-rooftop', threadId: 't-rooftop', labelIds: ['INBOX', 'UNREAD'] } }
        ]
      }
    ],
    threads: [arrival()]
  })
}

/**
 * Consent, the key, and a described split that notifies — then judge the
 * seeded mail against a "no" script, so the arrival is the only work the
 * scripted service has left. Important keeps its shipped notify setting: the
 * arrival carries no IMPORTANT label, so only the described split can announce
 * it, and the starter defaults stay under test.
 */
async function armNotifyingSplit(app: ElectronApplication, page: Page): Promise<void> {
  await installFakeTriage(app, { default: 0.05 })
  await page.evaluate(async () => {
    await window.attn.ai.setTriageKey('ts-test-key-notify')
    await window.attn.ai.setSetting('triageEnabled', true)
  })
  await page.evaluate(async (description) => {
    await window.attn.splits.save({
      name: 'Invites',
      operator: 'any',
      conditions: [{ type: 'description', value: description }],
      notify: true
    })
  }, INVITES)
  await runTriagePass(app)
}

interface NotifyDecision {
  /** The conversations main was offered, or `(none)`. */
  offered: string
  /** How many banners it planned, or `suppressed` where the OS shows none. */
  outcome: string
}

const DECISION = /\[notify] decision (\d+) (\S+) (.+) → (.+)$/

/**
 * Every notification decision main has made, oldest first. `mainLog` returns
 * the tee'd file and the captured stdout, so each line arrives twice; the
 * decision's serial number is what makes the copies collapse exactly.
 */
function notifyDecisions(log: string): NotifyDecision[] {
  const seen = new Map<string, NotifyDecision>()
  for (const line of log.split('\n')) {
    const match = DECISION.exec(line.trim())
    if (!match || match[2] !== ACCOUNT) continue
    seen.set(match[1], { offered: match[3], outcome: match[4] })
  }
  return [...seen.values()]
}

/** What each decision was offered — the answer that does not depend on the OS. */
function offeredThreads(log: string): string[] {
  return notifyDecisions(log).map((decision) => decision.offered)
}

/**
 * A decision that reached the notifier: it planned a banner, or the platform
 * has no notifier at all. `shown 0` would mean it decided to stay quiet, which
 * is the failure these tests exist to catch.
 */
function expectAnnounced(decision: NotifyDecision | undefined): void {
  expect(decision?.outcome ?? 'missing').not.toBe('shown 0')
}

/** The described split's tab. */
function describedTab(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid="split-tab"][data-split-id^="custom:"]')
}

test('an arrival judged inside the wait notifies once, out of its described split', async ({
  app,
  page,
  mainLog
}) => {
  await expect(page.getByTestId('split-strip')).toBeVisible()
  await armNotifyingSplit(app, page)
  await installFakeTriage(app, {
    default: 0.05,
    bySubject: [{ subjectIncludes: 'Rooftop', probabilities: { Invites: 0.94 } }]
  })

  await deliverArrival(app)
  await runTriagePass(app)

  // One decision, and it named the thread: the wait held the notification
  // until the judgment that put the conversation in a split that notifies.
  // Unjudged it would have sat in Other, which notifies nobody.
  await expect.poll(() => offeredThreads(mainLog())).toEqual(['t-rooftop'])
  expectAnnounced(notifyDecisions(mainLog())[0])

  await describedTab(page).click()
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText(ARRIVING_SUBJECT)
})

test('a judgment that lands after the wait announces the arrival once', async ({ app, page, mainLog }) => {
  await expect(page.getByTestId('split-strip')).toBeVisible()
  await armNotifyingSplit(app, page)
  // Slower than SPLIT_TRIAGE_NOTIFY_WAIT_MS, so the decision goes ahead on the
  // assignment the thread has now: Other, which notifies nobody.
  await installFakeTriage(app, {
    default: 0.05,
    delayMs: 3_500,
    bySubject: [{ subjectIncludes: 'Rooftop', probabilities: { Invites: 0.93 } }]
  })

  await deliverArrival(app)
  await expect.poll(() => offeredThreads(mainLog())[0] ?? null, { timeout: 8_000 }).toBe('(none)')

  // The judgment lands after the wait, moves the conversation, and announces
  // the arrival the wait could not.
  await runTriagePass(app)
  await expect.poll(() => offeredThreads(mainLog()), { timeout: 8_000 }).toEqual(['(none)', 't-rooftop'])
  expectAnnounced(notifyDecisions(mainLog())[1])

  await describedTab(page).click()
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText(ARRIVING_SUBJECT)

  // A further pass finds every conversation answered against its latest
  // message, so it asks the service nothing and decides nothing: the arrival
  // is announced once, not once per pass.
  await runTriagePass(app)
  await flushRendererIpc(page)
  expect(offeredThreads(mainLog())).toEqual(['(none)', 't-rooftop'])
})
