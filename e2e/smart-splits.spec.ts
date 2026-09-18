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
      notify: false,
      mode: 'description',
      description
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

test('turns smart splits on from its card and describes a split in the editor', async ({
  app,
  page
}, testInfo) => {
  // The pass a saved description starts must answer from the scripted service,
  // never the network.
  await installFakeTriage(app, { default: 0.05 })
  await page.getByTestId('split-rules-settings').click()
  await expect(page.getByTestId('split-rules')).toBeVisible()

  // Split rules owns the consent, the key, and the model.
  const card = page.getByTestId('smart-splits-card')
  const toggle = page.getByTestId('smart-splits-enabled')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('smart-splits-status')).toContainText('Off · Describe a split')
  await expect(page.getByTestId('smart-splits-model')).toHaveAttribute('placeholder', 'jev-latest')
  // Without a TypeSafe key there is nothing to consent to.
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()

  // Smart splits off: a new split can only be matched by rules.
  await page.getByTestId('split-rule-new').click()
  await expect(page.getByTestId('split-rule-mode-rules')).toHaveAttribute('aria-pressed', 'true')
  const describeIt = page.getByTestId('split-rule-mode-description')
  await expect(describeIt).toBeDisabled()
  await expect(describeIt).toHaveAttribute('title', 'Turn on smart splits to describe a split')

  // The key round trip shows presence only, never the value.
  await page.getByTestId('smart-splits-key').fill('ts-test-key-e2e')
  await page.getByTestId('smart-splits-key-save').click()
  await expect(page.getByTestId('smart-splits-key-present')).toHaveText(
    'ts-t\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022-e2e'
  )
  await expect(page.getByTestId('smart-splits-key')).toHaveCount(0)
  await expect(toggle).toBeEnabled()

  // Enabling is a consent flow: the checkbox alone writes nothing.
  await toggle.click()
  const disclosure = page.getByTestId('smart-splits-enable-confirm')
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText('sent to TypeSafe using your own key')
  await expect(disclosure).toContainText('recipient count')
  await expect(disclosure).toContainText('in the background without a command')
  await expect(disclosure).toContainText('cannot be recalled')
  await expect(toggle).not.toBeChecked()
  await page.getByTestId('smart-splits-enable-cancel').click()
  await expect(disclosure).toHaveCount(0)
  await expect(toggle).not.toBeChecked()

  await toggle.click()
  await page.getByTestId('smart-splits-enable-apply').click()
  await expect(toggle).toBeChecked()
  await expect(page.getByTestId('smart-splits-status')).toContainText('On \u00b7 no described splits yet')
  // Smart splits never turn AI writing on, and they carry a separate key.
  const aiSettings = await page.evaluate(() => window.attn.ai.getSettings())
  expect(aiSettings.enabled).toBe(false)
  expect(aiSettings.keyPresent).toBe(false)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const cardPath = join(artifactDirectory, 'split-rules-smart-card.png')
  await card.screenshot({ path: cardPath, animations: 'disabled' })
  await testInfo.attach('split-rules-smart-card', { path: cardPath, contentType: 'image/png' })

  // With smart splits on, a new split starts on Describe it.
  await page.getByTestId('split-rule-new').click()
  await expect(describeIt).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('split-rule-name').fill('Landlord')
  const description = page.getByTestId('split-rule-description')
  await expect(description).toBeVisible()
  await description.fill('Anything from my landlord, such as a rent receipt or a repair notice')
  await description.blur()

  const editorPath = join(artifactDirectory, 'split-rule-description.png')
  await page.screenshot({ path: editorPath, animations: 'disabled' })
  await testInfo.attach('split-rule-description', { path: editorPath, contentType: 'image/png' })

  // A mode switch never throws away typed words behind the user's back.
  await page.getByTestId('split-rule-mode-rules').click()
  const modeConfirm = page.getByTestId('split-rule-mode-confirm')
  await expect(modeConfirm).toContainText('Discard the description?')
  await expect(describeIt).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('split-rule-mode-confirm-cancel').click()
  await expect(modeConfirm).toHaveCount(0)
  await expect(description).toHaveValue(
    'Anything from my landlord, such as a rent receipt or a repair notice'
  )

  // Discarding switches for real, and the blank side asks nothing on the way back.
  await page.getByTestId('split-rule-mode-rules').click()
  await page.getByTestId('split-rule-mode-confirm-apply').click()
  await expect(page.getByTestId('split-rule-mode-rules')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('split-rule-description')).toHaveCount(0)
  await describeIt.click()
  await expect(modeConfirm).toHaveCount(0)
  await expect(description).toHaveValue('')
  await description.fill('Anything from my landlord, such as a rent receipt or a repair notice')

  await page.getByTestId('split-rule-save').click()
  const saved = page.locator('[data-testid="split-rule"][data-split-id^="custom:"]')
  const summary = saved.getByTestId('split-rule-summary')
  await expect(saved).toHaveCount(1)
  await expect(summary).toContainText('Landlord')
  await expect(summary).toContainText('Described')
  await expect(summary).not.toContainText('paused')

  // Turning smart splits off pauses the description; it never deletes it.
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(summary).toContainText('Described \u00b7 paused')

  // Removing the key withdraws the consent and blocks the toggle again.
  await page.getByTestId('smart-splits-key-remove').click()
  await expect(page.getByTestId('smart-splits-key')).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await expect(toggle).toBeDisabled()
  const cleared = await page.evaluate(() => window.attn.ai.getSettings())
  expect(cleared.triageEnabled).toBe(false)
  expect(cleared.triageKeyPresent).toBe(false)
  await expect(summary).toContainText('Described \u00b7 paused')

  await summary.click()
  await expect(page.getByTestId('split-rule-description')).toHaveValue(
    'Anything from my landlord, such as a rent receipt or a repair notice'
  )

  // AI writing settings only point here; the controls themselves are gone.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('split-rules')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('settings-ai')).toBeVisible()
  await expect(page.getByTestId('settings-ai-triage-enabled')).toHaveCount(0)
  await page.getByTestId('settings-ai-open-split-rules').click()
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
  await expect(page.getByTestId('smart-splits-card')).toBeVisible()
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
      notify: true,
      mode: 'description',
      description
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
