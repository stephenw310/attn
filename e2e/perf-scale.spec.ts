import type { ElectronApplication, TestInfo } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { THREAD_PAGE_SIZE } from '../src/shared/mail'
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

// Each ceiling sits between the two raw utility-process costs measured on this
// exact profile, so a failure means the read went back to scanning rather than
// that the machine is busy. On 2026-08-30, direct store timings on the 40,000-
// thread seed measured mailbox counts at 1.3 ms indexed and 38.3 ms scanning,
// and the All Mail page at 0.24 ms indexed and 29.5 ms scanning. These raw
// figures are not comparable to the older renderer IPC medians in T20. This
// spec now times the reads inside the utility process through a test-only IPC
// seam, because the renderer's ordinary mail-change refresh can warm
// `getMailboxCounts()` before a timed sample starts.
const MAILBOX_COUNTS_CEILING_MS = 15
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

interface QueryPerfStats {
  mailboxCounts: {
    samplesUs: number[]
    counts: { allMail: number }
  }
  allMailPage: {
    samplesUs: number[]
    rowCount: number
  }
  search: {
    samplesUs: number[]
    rowCount: number
    partial: boolean
  }
}

async function queryPerfStats(app: ElectronApplication, runsPerQuery: number): Promise<QueryPerfStats> {
  return app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<QueryPerfStats>((resolve) => {
        ipcMain.emit(input.channel, {}, input.request, resolve)
      }),
    {
      channel: TEST_CHANNELS.queryPerfStats,
      request: { runsPerQuery, threadLimit: THREAD_PAGE_SIZE + 1, searchQuery: 'performance' }
    }
  )
}

test.describe('@perfscale reads that must not scale with the store', () => {
  test('counts, pages, and searches a large profile without scanning it', async ({ app, page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toBeVisible()
    const stats = await queryPerfStats(app, SAMPLE_COUNT)
    const storedThreads = stats.mailboxCounts.counts.allMail
    // The profile has to be the large one, or every budget below is meaningless.
    expect(storedThreads, 'All Mail threads in the profile').toBeGreaterThan(PROFILE_THREADS / 2)
    expect(stats.allMailPage.rowCount, 'All Mail first page size').toBeGreaterThan(0)
    expect(stats.search.rowCount, 'common-term search result size').toBeGreaterThan(0)

    const countSamples = stats.mailboxCounts.samplesUs.map((sample) => sample / 1_000)
    const pageSamples = stats.allMailPage.samplesUs.map((sample) => sample / 1_000)
    await report(testInfo, 'scale-mailbox-counts', countSamples)
    await report(testInfo, 'scale-all-mail-page', pageSamples)
    expect(median(countSamples), 'median system mailbox counts').toBeLessThan(MAILBOX_COUNTS_CEILING_MS)
    expect(median(pageSamples), 'median All Mail first page').toBeLessThan(ALL_MAIL_PAGE_CEILING_MS)

    // "performance" appears in every thread's subject, which is the shape that
    // used to visit every matching message before returning a hundred rows.
    const searchSamples = stats.search.samplesUs.map((sample) => sample / 1_000)
    await report(testInfo, 'scale-common-term-search', searchSamples)
    expect(median(searchSamples), 'median common-term search').toBeLessThan(COMMON_TERM_SEARCH_CEILING_MS)
  })
})
