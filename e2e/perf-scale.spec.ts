import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron'

/**
 * Reads whose cost grows with the size of the store, measured on a profile large
 * enough for that growth to show.
 *
 * The 10,000-thread suite in perf.spec.ts cannot catch this class of regression.
 * The account-wide mailbox count that prompted this file took 584 ms on 800,000
 * threads and well under a millisecond on 10,000: a budget written against the
 * smaller profile passes either way, so the regression rode in unnoticed. These
 * budgets are deliberately far above the indexed cost and far below the scanning
 * cost, which is what makes a failure here mean "this read went back to scanning"
 * rather than "this machine is slow today".
 *
 * Opt-in: `npm run e2e:perf:scale`. It is excluded from `npm run verify` and from
 * the ordinary perf job because importing the profile takes minutes.
 */

const PROFILE_THREADS = 40_000
// The profile imports through the production write path in about 20 seconds.
// 40,000 threads rather than more because the seed is parsed whole: at 100,000
// the utility process died loading a 74 MB fixture, and streaming the fixture is
// a bigger change than this job is worth. Generous timeout: setup is not what is
// measured.
const SCALE_TEST_TIMEOUT_MS = 15 * 60_000
const SAMPLE_COUNT = 5

// Each ceiling sits between the two costs measured on this exact profile, so a
// failure means the read went back to scanning rather than that the machine is
// busy. Measured directly against the store at 40,000 threads: the mailbox
// counts cost 3.4 ms indexed and 26.8 ms scanning; the All Mail page 0.5 ms and
// 30.7 ms. Through IPC the healthy figures land near 19 ms and 6 ms, so a
// regression would read near 42 ms and 36 ms. Budgets any looser than this — the
// 150 ms this file first shipped with — pass either way and guard nothing.
const MAILBOX_COUNTS_CEILING_MS = 30
const ALL_MAIL_PAGE_CEILING_MS = 20
// An unbounded candidate set turns this into seconds; the bounded window is 134 ms.
const COMMON_TERM_SEARCH_CEILING_MS = 300

test.use({ seed: '.artifacts/perf-scale-seed.json' })
test.describe.configure({ retries: 0, timeout: SCALE_TEST_TIMEOUT_MS })

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function report(testInfo: TestInfo, name: string, samples: readonly number[]): Promise<void> {
  const result = { name, samplesMs: samples.map((sample) => Math.round(sample)), medianMs: median(samples) }
  console.log(`[perf-scale] ${JSON.stringify(result)}`)
  await testInfo.attach(`${name}-samples`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json'
  })
}

/**
 * Every sample is a cold read: mailbox counts and search coverage are cached per
 * mail change, so repeating a call without a write measures the cache instead of
 * the query. Starring a thread moves the revision and invalidates both.
 */
async function invalidateDerivedReads(page: Page): Promise<void> {
  await page.keyboard.press('s')
  await expect(page.getByTestId('thread-list')).toBeVisible()
}

test.describe('@perfscale reads that must not scale with the store', () => {
  test('counts, pages, and searches a large profile without scanning it', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toBeVisible()
    const storedThreads = await page.evaluate(async () => (await window.attn.mail.getMailboxCounts()).allMail)
    // The profile has to be the large one, or every budget below is meaningless.
    expect(storedThreads, 'All Mail threads in the profile').toBeGreaterThan(PROFILE_THREADS / 2)

    const countSamples: number[] = []
    const pageSamples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      await invalidateDerivedReads(page)
      countSamples.push(
        await page.evaluate(async () => {
          const started = performance.now()
          await window.attn.mail.getMailboxCounts()
          return performance.now() - started
        })
      )
      pageSamples.push(
        await page.evaluate(async () => {
          const started = performance.now()
          await window.attn.mail.listThreadPage('allMail')
          return performance.now() - started
        })
      )
    }
    await report(testInfo, 'scale-mailbox-counts', countSamples)
    await report(testInfo, 'scale-all-mail-page', pageSamples)
    expect(median(countSamples), 'median system mailbox counts').toBeLessThan(MAILBOX_COUNTS_CEILING_MS)
    expect(median(pageSamples), 'median All Mail first page').toBeLessThan(ALL_MAIL_PAGE_CEILING_MS)

    // "performance" appears in every thread's subject, which is the shape that
    // used to visit every matching message before returning a hundred rows.
    const searchSamples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      await invalidateDerivedReads(page)
      searchSamples.push(
        await page.evaluate(async () => {
          const started = performance.now()
          const response = await window.attn.mail.search('performance')
          if (response.rows.length === 0) throw new Error('common-term search returned nothing')
          return performance.now() - started
        })
      )
    }
    await report(testInfo, 'scale-common-term-search', searchSamples)
    expect(median(searchSamples), 'median common-term search').toBeLessThan(COMMON_TERM_SEARCH_CEILING_MS)
  })
})
