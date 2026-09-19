import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { AUTOCOMPLETE_MIN_START_INTERVAL_MS } from '../src/shared/ai'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { THREAD_PAGE_SIZE } from '../src/shared/mail'
import { expect, test } from './electron'

const SAMPLE_COUNT = 5
const PERF_TEST_TIMEOUT_MS = 120_000
const LIST_RENDER_CEILING_MS = 2_000
const LOCAL_REFRESH_CEILING_MS = 2_000
const CONVERSATION_OPEN_CEILING_MS = 50
const TRIAGE_FEEDBACK_CEILING_MS = 16
const SCROLL_FRAME_P95_CEILING_MS = 20
const COMPOSER_OPEN_WARMUP_COUNT = 2
const COMPOSER_OPEN_CEILING_MS = 50
const SEARCH_QUERY_CEILING_MS = 100
const PALETTE_OPEN_CEILING_MS = 50
const PALETTE_RERANK_CEILING_MS = 30
const SPLIT_SWITCH_CEILING_MS = 50
const SPLIT_REBUCKET_CEILING_MS = 1_000
// §7's F18 budget: a warm account switch renders the other account's cached
// list in under 100ms — the whole journey, guarded switch through utility
// pointer flip to the remounted first page of rows. Keep that acceptance gate
// on developer hardware. GitHub's hosted Linux runners have produced unrelated
// scheduling stalls in this path (including 243ms on main, followed by 68ms on
// the next PR without a product-path change), so CI uses a regression-smoke
// ceiling that still catches an order-of-magnitude slowdown.
const ACCOUNT_SWITCH_PRODUCT_BUDGET_MS = 100
const ACCOUNT_SWITCH_HOSTED_LINUX_CEILING_MS = 300
const ACCOUNT_SWITCH_CEILING_MS =
  process.env.CI && process.platform === 'linux'
    ? ACCOUNT_SWITCH_HOSTED_LINUX_CEILING_MS
    : ACCOUNT_SWITCH_PRODUCT_BUDGET_MS
const COMPOSER_MUTATION_CEILING_MS = 8
// Two 60Hz vsync intervals. The paint sample is timed from before the key is
// dispatched, so on its own it carries CDP dispatch latency plus a wait for the
// next vsync — up to a whole frame of neither-app-nor-regression noise. Sampling
// harder does not help: p95 of that absolute number converges above 20ms even
// when every keystroke paints perfectly. Subtracting the mutation sample cancels
// the dispatch cost and leaves the guarantee worth holding — the edit reaches the
// next frame. A delta over one interval means a dropped frame; two is the
// tolerance for a single dropped frame on a shared CI runner.
const COMPOSER_PAINT_DELTA_P95_CEILING_MS = 34
const MEMORY_CEILING_MB = 500
// Sub-pixel rounding only; anything larger is a real clipped row.
const SELECTION_EDGE_TOLERANCE_PX = 1
// A row scrolled to the bottom edge settles one padding step (8px) away. The
// regression this guards against parks it a header height (~57px) away, so the
// ceiling sits well clear of both.
const SELECTION_SLACK_CEILING_PX = 24

test.use({ seed: '.generated/perf-seed.json' })
// GitHub's Linux runner can spend close to the ordinary 30-second test timeout
// importing the 10,000-thread seed before a metric starts. Keep the measured
// interaction ceilings strict while giving fixture setup and teardown headroom.
// A retry would hide the instability this smoke is intended to expose.
test.describe.configure({ retries: 0, timeout: PERF_TEST_TIMEOUT_MS })

test.describe('@perf focused-row archive motion', () => {
  test.use({ seed: 'fixtures/seed-inbox.json' })

  test('projects the replacement row toward the vacated slot in the archive keydown commit', async ({
    page
  }) => {
    const rows = page.getByTestId('thread-row')
    await expect(rows).toHaveCount(8)
    const nextRow = rows.filter({ hasText: 'Northstar Books' })
    const wrapperTop = await nextRow.evaluate(
      (element) => element.closest<HTMLElement>('.absolute')?.style.top ?? ''
    )

    await page.keyboard.press('e')
    await expect(rows.first()).toHaveAttribute('data-exiting', 'true')
    await expect(nextRow).toHaveAttribute('data-selected', 'true')
    // Every list is windowed, so the replacement motion is a transitioned `top`
    // on the surviving row's wrapper: the projected target is set immediately
    // with the transition class, while the exiting row overlays its old slot.
    const projected = await nextRow.evaluate((element) => {
      const wrapper = element.closest<HTMLElement>('.absolute')
      if (!wrapper) throw new Error('windowed row wrapper missing')
      return {
        top: wrapper.style.top,
        shifting: wrapper.classList.contains('app-thread-position-shift')
      }
    })
    expect(projected.shifting).toBe(true)
    expect(Number.parseFloat(projected.top)).toBeLessThan(Number.parseFloat(wrapperTop) - 2)
    await expect(rows).toHaveCount(7)
  })
})

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
}

async function reportMetric(
  testInfo: TestInfo,
  name: string,
  samples: readonly number[],
  medianMs: number,
  warmupSamples: readonly number[] = []
): Promise<void> {
  const result = {
    name,
    ...(warmupSamples.length > 0
      ? { warmupSamplesMs: warmupSamples.map((sample) => Math.round(sample)) }
      : {}),
    samplesMs: samples.map((sample) => Math.round(sample)),
    medianMs: Math.round(medianMs),
    p95Ms: Math.round(percentile(samples, 0.95))
  }
  console.log(`[perf] ${JSON.stringify(result)}`)
  await testInfo.attach(`${name}-samples`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json'
  })
}

interface UtilityMemoryKb {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  sqliteCacheBudget: number
}

async function utilityMemoryKb(app: ElectronApplication): Promise<UtilityMemoryKb> {
  return app.evaluate(
    ({ ipcMain }, channel) =>
      new Promise<UtilityMemoryKb>((resolve, reject) =>
        ipcMain.emit(channel, {}, [], (result: { utilityMemoryKb?: UtilityMemoryKb; error?: string }) => {
          if (result.error) reject(new Error(result.error))
          else if (result.utilityMemoryKb) resolve(result.utilityMemoryKb)
          else reject(new Error('utility memory measurement unavailable'))
        })
      ),
    TEST_CHANNELS.utilityState
  )
}

async function measureListRender(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const listIsReady = (): boolean =>
      document.querySelector('[data-testid="thread-list"]')?.getAttribute('data-thread-count') === '100'
    if (listIsReady()) return performance.now()

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out before the first 100-thread page became readable'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (!listIsReady()) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now())
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  })
}

/**
 * Both waves of a mail refresh, in the order the renderer issues them: the rows
 * that the window shows, then the sidebar counts and header chips. Counting was
 * missing from this measurement, which is how it grew unnoticed into the slowest
 * read in the refresh. A 10,000-thread profile only catches gross regressions in
 * it; a size-dependent one needs a larger generated profile.
 */
async function measureLocalMailRefresh(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = performance.now()
    await Promise.all([
      window.attn.mail.listThreadPage('inbox'),
      window.attn.mail.listSnoozedPage(),
      window.attn.draft.list(),
      window.attn.outbox.listPending()
    ])
    await Promise.all([
      window.attn.mail.listLabels(),
      window.attn.mail.getMailboxCounts(),
      window.attn.mail.getUnreadCount(),
      window.attn.mail.getActionQueueStatus()
    ])
    return performance.now() - started
  })
}

async function selectionGeometry(page: Page): Promise<{
  gapAbove: number
  gapBelow: number
  index: number
}> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="thread-list"]')
    if (!list) throw new Error('missing thread list')
    const selected = document.querySelector<HTMLElement>('[data-testid="thread-row"][data-selected="true"]')
    if (!selected) throw new Error('selected row is not mounted')
    const listRect = list.getBoundingClientRect()
    const rowRect = selected.getBoundingClientRect()
    return {
      gapAbove: rowRect.top - listRect.top,
      gapBelow: listRect.bottom - rowRect.bottom,
      index: Number(selected.getAttribute('data-thread-index'))
    }
  })
}

async function pressRepeatedly(page: Page, key: string, times: number): Promise<void> {
  for (let iteration = 0; iteration < times; iteration++) {
    await page.evaluate((pressed) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true }))
    }, key)
  }
  await page.evaluate(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function measureConversationOpen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const contentIsReady = (): boolean =>
      document.querySelector('[data-testid="conversation-content"]') !== null
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    if (contentIsReady()) return performance.now() - started

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out opening cached conversation content'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (!contentIsReady()) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  })
}

async function measurePaletteOpen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = performance.now()
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    if (document.querySelector('[data-testid="command-palette"]')) return performance.now() - started
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out opening the command palette'))
      }, 5_000)
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="command-palette"]')) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  })
}

async function measurePaletteRerank(page: Page, query: string): Promise<number> {
  return page.evaluate(async (nextQuery) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')
    const results = document.querySelector<HTMLElement>('[data-testid="command-palette-results"]')
    if (!input || !results) throw new Error('command palette is not open')
    const started = performance.now()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, nextQuery)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (results.dataset.paletteQuery === nextQuery) return performance.now() - started
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out re-ranking command palette results'))
      }, 5_000)
      const observer = new MutationObserver(() => {
        if (results.dataset.paletteQuery !== nextQuery) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(results, { attributes: true, attributeFilter: ['data-palette-query'] })
    })
  }, query)
}

async function measureMailboxSwitch(page: Page, chordKey: string, expectedTitle: string): Promise<number> {
  return page.evaluate(
    async ({ pressed, title }) => {
      const ready = (): boolean =>
        document.querySelector('[data-testid="mailbox-title"]')?.textContent === title &&
        document.querySelector('[data-testid="thread-list"]')?.getAttribute('data-thread-count') === '100'
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
      const started = performance.now()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true }))
      if (ready()) return performance.now() - started

      return new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error(`Timed out switching to ${title}`))
        }, 10_000)
        const observer = new MutationObserver(() => {
          if (!ready()) return
          window.clearTimeout(timeout)
          observer.disconnect()
          resolve(performance.now() - started)
        })
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        })
      })
    },
    { pressed: chordKey, title: expectedTitle }
  )
}

async function measureSplitSwitch(
  page: Page,
  direction: 'next' | 'previous',
  splitId: string,
  expectedCount: number
): Promise<number> {
  return page.evaluate(
    async ({ move, expectedSplitId, count }) => {
      const ready = (): boolean =>
        document
          .querySelector(`[data-testid="split-tab"][data-split-id="${expectedSplitId}"]`)
          ?.getAttribute('aria-selected') === 'true' &&
        (count === 0
          ? document.querySelector('[data-testid="inbox-zero"]') !== null
          : document.querySelector('[data-testid="thread-list"]')?.getAttribute('data-thread-count') ===
            String(count))
      const started = performance.now()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: move === 'previous', bubbles: true })
      )
      if (ready()) return performance.now() - started
      return new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error(`Timed out switching to split ${expectedSplitId}`))
        }, 10_000)
        const observer = new MutationObserver(() => {
          if (!ready()) return
          window.clearTimeout(timeout)
          observer.disconnect()
          resolve(performance.now() - started)
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true })
      })
    },
    { move: direction, expectedSplitId: splitId, count: expectedCount }
  )
}

async function measureAccountSwitch(
  page: Page,
  digit: number,
  email: string,
  firstSubject: string
): Promise<number> {
  return page.evaluate(
    async ({ pressed, address, subject }) => {
      const ready = (): boolean =>
        (document.querySelector('[data-testid="account-menu"]')?.textContent ?? '').includes(address) &&
        document.querySelector('[data-testid="thread-list"]')?.getAttribute('data-thread-count') === '100' &&
        (document.querySelector('[data-testid="thread-subject"]')?.textContent ?? '').includes(subject)
      const mac = /mac/i.test(navigator.platform)
      const started = performance.now()
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: String(pressed),
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true
        })
      )
      if (ready()) return performance.now() - started
      return new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error(`Timed out switching to ${address}`))
        }, 10_000)
        const observer = new MutationObserver(() => {
          if (!ready()) return
          window.clearTimeout(timeout)
          observer.disconnect()
          resolve(performance.now() - started)
        })
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        })
      })
    },
    { pressed: digit, address: email, subject: firstSubject }
  )
}

test.describe('@perf account switching with split inboxes', () => {
  // Derived from the generated perf seed, so it belongs beside it in the
  // gitignored `.generated/` directory rather than in the uploaded artifacts.
  test.use({ seed: '.generated/perf-split-seed.json' })
  test.beforeAll(() => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '.generated/perf-seed.json'), 'utf8')) as {
      accounts: Array<{
        splitSetup?: boolean
        threads: Array<{ messages: Array<{ labelIds: string[] }> }>
      }>
    }
    for (const account of fixture.accounts) {
      account.splitSetup = true
      for (const thread of account.threads) {
        for (const message of thread.messages) message.labelIds.push('IMPORTANT')
      }
    }
    mkdirSync(join(__dirname, '.generated'), { recursive: true })
    writeFileSync(join(__dirname, '.generated/perf-split-seed.json'), JSON.stringify(fixture))
  })

  test('switches split inboxes within the account-switch performance gate', async ({ boot }, testInfo) => {
    // Measure warm cached mail in a process that did not just import 11,000
    // threads. Import-time garbage collection otherwise overlaps these samples.
    // Relaunch preserves the real database and still exercises every switch.
    const { page } = await boot.relaunch()
    await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '100')
    await expect(page.locator('[data-testid="split-tab"][data-split-id="base:important"]')).toHaveAttribute(
      'data-active',
      'true'
    )
    const warmSecond = await measureAccountSwitch(page, 2, 'perf-second@attn.test', 'Second account thread')
    const warmFirst = await measureAccountSwitch(page, 1, 'perf@attn.test', 'Performance thread')
    const toFirst: number[] = []
    const toSecond: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      toSecond.push(await measureAccountSwitch(page, 2, 'perf-second@attn.test', 'Second account thread'))
      toFirst.push(await measureAccountSwitch(page, 1, 'perf@attn.test', 'Performance thread'))
    }
    await reportMetric(testInfo, 'split-account-switch-to-first', toFirst, median(toFirst), [warmFirst])
    await reportMetric(testInfo, 'split-account-switch-to-second', toSecond, median(toSecond), [warmSecond])
    expect(percentile(toFirst, 0.95), 'p95 warm switch to the larger split inbox').toBeLessThan(
      ACCOUNT_SWITCH_CEILING_MS
    )
    expect(percentile(toSecond, 0.95), 'p95 warm switch to the smaller split inbox').toBeLessThan(
      ACCOUNT_SWITCH_CEILING_MS
    )
  })
})

async function measureTriageFeedback(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const selected = document.querySelector<HTMLElement>('[data-testid="thread-row"][data-selected="true"]')
    if (!selected) throw new Error('missing selected thread')
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    if (selected.dataset.exiting === 'true') return performance.now() - started

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out waiting for triage feedback'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (selected.dataset.exiting !== 'true') return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(selected, { attributes: true, attributeFilter: ['data-exiting'] })
    })
  })
}

async function measureThreadFlagFeedback(
  page: Page,
  key: 's' | 'u',
  attribute: 'data-starred' | 'data-unread'
): Promise<number> {
  return page.evaluate(
    async ({ pressed, watchedAttribute }) => {
      const selected = document.querySelector<HTMLElement>('[data-testid="thread-row"][data-selected="true"]')
      if (!selected) throw new Error('missing selected thread')
      const startedOn = selected.getAttribute(watchedAttribute) === 'true'
      const feedbackLanded = (): boolean => (selected.getAttribute(watchedAttribute) === 'true') !== startedOn
      const started = performance.now()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true }))
      if (feedbackLanded()) return performance.now() - started

      return new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error(`Timed out waiting for ${watchedAttribute} feedback`))
        }, 10_000)
        const observer = new MutationObserver(() => {
          if (!feedbackLanded()) return
          window.clearTimeout(timeout)
          observer.disconnect()
          resolve(performance.now() - started)
        })
        observer.observe(selected, { attributes: true, attributeFilter: [watchedAttribute] })
      })
    },
    { pressed: key, watchedAttribute: attribute }
  )
}

async function measureComposerOpen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    if (document.querySelector('[data-testid="composer"]')) return performance.now() - started
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out opening composer'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="composer"]')) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  })
}

async function measureComposerKeystroke(
  page: Page,
  key: string
): Promise<{ mutationMs: number; paintMs: number; paintDeltaMs: number }> {
  const editor = page.getByTestId('composer-editor')
  await editor.evaluate((element) => {
    delete element.dataset.keystrokeMutationMs
    delete element.dataset.keystrokePaintMs
    const started = performance.now()
    const observer = new MutationObserver(() => {
      observer.disconnect()
      element.dataset.keystrokeMutationMs = String(performance.now() - started)
      requestAnimationFrame(() => {
        element.dataset.keystrokePaintMs = String(performance.now() - started)
      })
    })
    observer.observe(element, { characterData: true, childList: true, subtree: true })
  })
  await page.keyboard.type(key)
  await expect.poll(() => editor.getAttribute('data-keystroke-paint-ms')).not.toBeNull()
  const mutationMs = Number(await editor.getAttribute('data-keystroke-mutation-ms'))
  const paintMs = Number(await editor.getAttribute('data-keystroke-paint-ms'))
  // Both are timed from the same origin, so the difference is exactly the wait
  // from the DOM mutation to the frame that shows it.
  return { mutationMs, paintMs, paintDeltaMs: paintMs - mutationMs }
}

/** Tab acceptance of a visible autocomplete suggestion, input to paint (T37A). */
async function measureComposerAcceptance(
  page: Page
): Promise<{ mutationMs: number; paintMs: number; paintDeltaMs: number }> {
  const editor = page.getByTestId('composer-editor')
  await editor.evaluate((element) => {
    delete element.dataset.keystrokeMutationMs
    delete element.dataset.keystrokePaintMs
    const started = performance.now()
    const observer = new MutationObserver(() => {
      observer.disconnect()
      element.dataset.keystrokeMutationMs = String(performance.now() - started)
      requestAnimationFrame(() => {
        element.dataset.keystrokePaintMs = String(performance.now() - started)
      })
    })
    observer.observe(element, { characterData: true, childList: true, subtree: true })
  })
  await page.keyboard.press('Tab')
  await expect.poll(() => editor.getAttribute('data-keystroke-paint-ms')).not.toBeNull()
  const mutationMs = Number(await editor.getAttribute('data-keystroke-mutation-ms'))
  const paintMs = Number(await editor.getAttribute('data-keystroke-paint-ms'))
  return { mutationMs, paintMs, paintDeltaMs: paintMs - mutationMs }
}

async function measureScrollFrames(page: Page): Promise<number[]> {
  return page.getByTestId('thread-list').evaluate(async (list) => {
    const samples: number[] = []
    const distance = Math.min(list.scrollHeight - list.clientHeight, 20_000)
    let previous = performance.now()
    for (let frame = 1; frame <= 120; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame((now) => {
          samples.push(now - previous)
          previous = now
          list.scrollTop = (distance * frame) / 120
          resolve()
        })
      )
    }
    return samples.slice(5)
  })
}

test.describe('@perf 10,000-thread profile with paged mailboxes', () => {
  test('renders the list within the CI-safe ceiling', async ({ boot, page }, testInfo) => {
    const samples: number[] = []
    let currentPage = page
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureListRender(currentPage))
      if (iteration < SAMPLE_COUNT - 1) currentPage = (await boot.relaunch()).page
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'list-render', samples, medianMs)
    expect(medianMs, 'median navigation start to first readable window').toBeLessThan(LIST_RENDER_CEILING_MS)
  })

  test('loads mailbox rows in 100-conversation pages', async ({ page }) => {
    const list = page.getByTestId('thread-list')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_PAGE_SIZE))
    await expect(list).toHaveAttribute('data-has-more', 'true')

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const scrollTopBeforeAppend = await list.evaluate((element) => element.scrollTop)

    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_PAGE_SIZE * 2))
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(scrollTopBeforeAppend)
    expect(await page.getByTestId('thread-row').count()).toBeLessThan(100)
  })

  test('switches accounts warm within the F18 performance gate', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    await expect(page.getByTestId('account-menu')).toContainText('perf@attn.test')

    // First visits pay one-time mount and read costs on each side; the budget
    // is the *warm* switch (§7), so both surfaces are visited before sampling.
    const warmup = [
      await measureAccountSwitch(page, 2, 'perf-second@attn.test', 'Second account thread'),
      await measureAccountSwitch(page, 1, 'perf@attn.test', 'Performance thread')
    ]
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureAccountSwitch(page, 2, 'perf-second@attn.test', 'Second account thread'))
      samples.push(await measureAccountSwitch(page, 1, 'perf@attn.test', 'Performance thread'))
    }

    await reportMetric(testInfo, 'account-switch', samples, median(samples), warmup)
    expect(percentile(samples, 0.95), 'p95 warm account switch').toBeLessThan(ACCOUNT_SWITCH_CEILING_MS)
  })

  test('re-buckets 10,000 threads and switches splits within the F11 budgets', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const mutation = await page.evaluate(async () => {
      const started = performance.now()
      const state = await window.attn.splits.save({
        name: 'Generated mail',
        notify: false,
        mode: 'rules',
        operator: 'any',
        conditions: [{ type: 'senderDomain', value: 'example.test' }]
      })
      const split = state.splits.find((candidate) => candidate.name === 'Generated mail')
      if (!split) throw new Error('Generated split was not created')
      return { durationMs: performance.now() - started, splitId: split.id }
    })
    await reportMetric(testInfo, 'split-rule-rebucket', [mutation.durationMs], mutation.durationMs)
    expect(mutation.durationMs, 'rule mutation and 10,000-thread re-bucket').toBeLessThan(
      SPLIT_REBUCKET_CEILING_MS
    )
    await expect(page.getByTestId('split-tab')).toHaveCount(3)

    // New custom splits follow Important. Exercise the supported Tab navigation;
    // numbered G chords are no longer assigned to split commands.
    const coldMs = await measureSplitSwitch(page, 'next', mutation.splitId, THREAD_PAGE_SIZE)
    await reportMetric(testInfo, 'split-switch-cold', [coldMs], coldMs)
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      await measureSplitSwitch(page, 'previous', 'base:important', 0)
      samples.push(await measureSplitSwitch(page, 'next', mutation.splitId, THREAD_PAGE_SIZE))
    }
    await reportMetric(testInfo, 'split-switch', samples, median(samples))
    expect(percentile(samples, 0.95), 'p95 split switch').toBeLessThan(SPLIT_SWITCH_CEILING_MS)
  })

  test('windows the list and sustains scroll-frame pacing inside the memory budget', async ({
    app,
    page
  }, testInfo) => {
    const list = page.getByTestId('thread-list')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_PAGE_SIZE))
    await expect(list).toHaveAttribute('data-virtualized', 'true')
    expect(await page.getByTestId('thread-row').count()).toBeLessThan(100)

    const frameSamples = await measureScrollFrames(page)
    const frameMedianMs = median(frameSamples)
    const frameP95Ms = percentile(frameSamples, 0.95)
    await reportMetric(testInfo, 'list-scroll-frame', frameSamples, frameMedianMs)
    expect(frameP95Ms, 'p95 requestAnimationFrame interval while scrolling').toBeLessThan(
      SCROLL_FRAME_P95_CEILING_MS
    )

    // Chromium's macOS working-set figures count shared Electron pages once per
    // process, so summing them badly overstates memory owned by Attn. Main private
    // memory plus the utility's live heap/external allocations and configured
    // SQLite cache ceiling captures app-owned allocations. Utility RSS is diagnostic
    // only on macOS because the Plugin helper maps nearly 1 GB of shared Electron
    // pages. Renderer JS heap captures the 10k-thread model. The virtualized DOM
    // remains separately bounded by the row-count assertion above.
    const mainPrivateKb = await app.evaluate(async () => (await process.getProcessMemoryInfo()).private)
    const utilityMemory = await utilityMemoryKb(app)
    const rendererHeapBytes = await page.evaluate(
      () =>
        (
          performance as Performance & {
            memory?: { usedJSHeapSize: number }
          }
        ).memory?.usedJSHeapSize ?? 0
    )
    expect(rendererHeapBytes, 'Chromium renderer heap measurement is available').toBeGreaterThan(0)
    const utilityOwnedKb = utilityMemory.heapUsed + utilityMemory.external + utilityMemory.sqliteCacheBudget
    const memoryMb = Math.round(
      mainPrivateKb / 1024 + utilityOwnedKb / 1024 + rendererHeapBytes / 1024 / 1024
    )
    const memoryResult = {
      applicationOwnedMemoryMb: memoryMb,
      mainPrivateMb: Math.round(mainPrivateKb / 1024),
      utilityRssMb: Math.round(utilityMemory.rss / 1024),
      utilityHeapUsedMb: Math.round(utilityMemory.heapUsed / 1024),
      utilityExternalMb: Math.round(utilityMemory.external / 1024),
      utilitySqliteCacheBudgetMb: Math.round(utilityMemory.sqliteCacheBudget / 1024),
      utilityOwnedMb: Math.round(utilityOwnedKb / 1024),
      rendererHeapMb: Math.round(rendererHeapBytes / 1024 / 1024),
      ceilingMb: MEMORY_CEILING_MB
    }
    console.log(`[perf] ${JSON.stringify({ name: 'steady-state-memory', ...memoryResult })}`)
    await testInfo.attach('steady-state-memory', {
      body: JSON.stringify(memoryResult, null, 2),
      contentType: 'application/json'
    })
    expect(memoryMb, 'main private memory plus utility-owned allocations and renderer JS heap').toBeLessThan(
      MEMORY_CEILING_MB
    )
  })

  test('answers search index queries within the CI-safe ceiling', async ({ app, page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    // Realistic MATCH shapes over the generated profile: the broadest term hits
    // every message, the prefix drives as-you-type, the rest are narrow.
    const stats = await app.evaluate(
      ({ ipcMain }, { channel, input }) =>
        new Promise<{
          error?: string
          indexBytes: number
          queries: { match: string; threadCount: number; samplesUs: number[] }[]
        }>((resolve) => ipcMain.emit(channel, {}, input, resolve)),
      {
        channel: TEST_CHANNELS.searchIndexStats,
        input: {
          queries: ['performance', 'perf*', 'cached', '"performance thread 9999"', 'sender42'],
          runsPerQuery: 20,
          limit: 50
        }
      }
    )
    expect(stats.error).toBeUndefined()
    expect(stats.queries.find((query) => query.match === 'performance')?.threadCount).toBe(50)
    expect(stats.queries.find((query) => query.match === '"performance thread 9999"')?.threadCount).toBe(1)
    expect(stats.queries.find((query) => query.match === 'sender42')?.threadCount).toBe(1)

    const samples = stats.queries.flatMap((query) => query.samplesUs.map((sample) => sample / 1_000))
    const medianMs = median(samples)
    await reportMetric(testInfo, 'search-index-query', samples, medianMs)
    const sizeResult = {
      name: 'search-index-size',
      indexBytes: stats.indexBytes,
      indexMb: Math.round((stats.indexBytes / 1024 / 1024) * 10) / 10,
      perQueryP95Ms: stats.queries.map((query) => ({
        match: query.match,
        threadCount: query.threadCount,
        p95Ms: Math.round(percentile(query.samplesUs, 0.95) / 100) / 10
      }))
    }
    console.log(`[perf] ${JSON.stringify(sizeResult)}`)
    await testInfo.attach('search-index-size', {
      body: JSON.stringify(sizeResult, null, 2),
      contentType: 'application/json'
    })
    expect(stats.indexBytes, 'FTS index pages exist on disk').toBeGreaterThan(0)
    expect(percentile(samples, 0.95), 'p95 FTS query latency').toBeLessThan(SEARCH_QUERY_CEILING_MS)
  })

  test.describe('50,000-message search profile', () => {
    test.use({ seed: '.generated/perf-search-seed.json' })

    test('renders local search results within budget', async ({ page }, testInfo) => {
      test.setTimeout(180_000)
      await expect(page.getByTestId('thread-list')).toHaveAttribute(
        'data-thread-count',
        String(THREAD_PAGE_SIZE)
      )
      await page.keyboard.press('/')
      const input = page.getByTestId('search-input')
      await expect(input).toBeFocused()
      const samples: number[] = []
      for (let run = 0; run < 20; run++) {
        const address = `sender${42 + run}@example.test`
        const query = `from:"${address}" has:attachment after:2026-01-01 in:inbox`
        const started = await page.evaluate(() => performance.now())
        await input.fill(query)
        await page.waitForFunction(
          (completedQuery) =>
            document.querySelector<HTMLElement>('[data-testid="search-coverage"]')?.dataset.searchQuery ===
              completedQuery &&
            document.querySelector<HTMLElement>('[data-testid="thread-list"]')?.dataset.threadCount === '1',
          query,
          { polling: 'raf' }
        )
        samples.push(await page.evaluate((start) => performance.now() - start, started))
      }
      const medianMs = median(samples)
      await reportMetric(testInfo, 'search-keystroke-to-results', samples, medianMs)
      expect(percentile(samples, 0.95)).toBeLessThan(SEARCH_QUERY_CEILING_MS)
    })
  })

  test('opens mounted conversation content within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureConversationOpen(page))
      await expect(page.getByTestId('conversation-content')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('conversation-view')).toHaveCount(0)
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'conversation-open', samples, medianMs)
    expect(medianMs, 'median Enter to conversation content mounted').toBeLessThan(
      CONVERSATION_OPEN_CEILING_MS
    )
  })

  test('opens and re-ranks the command palette within F5 budgets', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const openSamples: number[] = []
    for (let iteration = 0; iteration < 20; iteration++) {
      openSamples.push(await measurePaletteOpen(page))
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('command-palette')).toHaveCount(0)
    }
    await reportMetric(testInfo, 'command-palette-open', openSamples, median(openSamples))
    expect(percentile(openSamples, 0.95)).toBeLessThan(PALETTE_OPEN_CEILING_MS)

    await measurePaletteOpen(page)
    const rerankSamples: number[] = []
    for (let iteration = 0; iteration < 20; iteration++) {
      rerankSamples.push(await measurePaletteRerank(page, `go to ${iteration}`))
    }
    await reportMetric(testInfo, 'command-palette-rerank', rerankSamples, median(rerankSamples))
    expect(percentile(rerankSamples, 0.95)).toBeLessThan(PALETTE_RERANK_CEILING_MS)
  })

  test('switches to a cached All Mail within the F3 budget', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    // The cold first visit queries and transfers one page. Report it separately
    // so the cached switch budget still catches renderer regressions.
    const coldMs = await measureMailboxSwitch(page, 'a', 'All Mail')
    await reportMetric(testInfo, 'mailbox-switch-cold', [coldMs], coldMs)

    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      await measureMailboxSwitch(page, 'i', 'Inbox')
      samples.push(await measureMailboxSwitch(page, 'a', 'All Mail'))
    }
    const medianMs = median(samples)
    await reportMetric(testInfo, 'mailbox-switch', samples, medianMs)
    expect(medianMs, 'median cached switch to All Mail').toBeLessThan(CONVERSATION_OPEN_CEILING_MS)
  })

  test('refreshes the first local mail page within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureLocalMailRefresh(page))
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'local-mail-refresh', samples, medianMs)
    expect(medianMs, 'median first-page local refresh').toBeLessThan(LOCAL_REFRESH_CEILING_MS)
  })

  test('keeps a keyboard selection fully visible while scrolling a loaded page', async ({ page }) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )

    // Step past the fold so the list has to scroll, then keep stepping: the
    // follow scroll must converge rather than leaving a constant offset behind.
    await pressRepeatedly(page, 'j', 40)
    for (let iteration = 0; iteration < 5; iteration++) {
      await pressRepeatedly(page, 'j', 1)
      const { gapAbove, gapBelow, index } = await selectionGeometry(page)
      expect(gapAbove, `row ${index} clipped at the top of the list`).toBeGreaterThanOrEqual(
        -SELECTION_EDGE_TOLERANCE_PX
      )
      expect(gapBelow, `row ${index} clipped at the bottom of the list`).toBeGreaterThanOrEqual(
        -SELECTION_EDGE_TOLERANCE_PX
      )
      // A row pulled to the bottom edge should sit against it. A larger gap
      // means the follow scroll overshot by some fixed layout offset.
      expect(gapBelow, `row ${index} overshot the bottom edge`).toBeLessThan(SELECTION_SLACK_CEILING_PX)
    }

    // Walking back to the top must land the first row fully inside the viewport.
    await pressRepeatedly(page, 'k', 60)
    const atTop = await selectionGeometry(page)
    expect(atTop.index, 'k should walk back to the first row').toBe(0)
    expect(atTop.gapAbove, 'first row clipped at the top of the list').toBeGreaterThanOrEqual(
      -SELECTION_EDGE_TOLERANCE_PX
    )
  })

  test('removes triaged rows within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureTriageFeedback(page))
      await expect(page.getByTestId('thread-list')).toHaveAttribute(
        'data-thread-count',
        String(THREAD_PAGE_SIZE)
      )
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'triage-feedback', samples, medianMs)
    expect(medianMs, 'median e keydown to selected row removed').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
  })

  test('shows star and unread feedback within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )
    const samples = [
      await measureThreadFlagFeedback(page, 's', 'data-starred'),
      await measureThreadFlagFeedback(page, 'u', 'data-unread')
    ]
    const medianMs = median(samples)
    await reportMetric(testInfo, 'thread-flag-feedback', samples, medianMs)
    expect(medianMs, 'median S/U keydown to focused-row feedback').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
  })

  test('archives and reverses a 100-thread selection without missing the feedback budget', async ({
    page
  }, testInfo) => {
    const list = page.getByTestId('thread-list')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_PAGE_SIZE))
    await page.evaluate(() => {
      window.addEventListener('error', (event) => {
        document.documentElement.dataset.perfReactError = event.error?.stack ?? event.message
      })
    })
    await page.keyboard.press('x')
    for (let index = 1; index < 100; index++) await page.keyboard.press('Shift+j')
    await expect(page.getByTestId('selection-count')).toHaveText('100 selected')
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()
    const loadedBeforeArchive = Number(await list.getAttribute('data-thread-count'))
    expect(loadedBeforeArchive).toBeGreaterThanOrEqual(THREAD_PAGE_SIZE)

    const feedbackMs = await measureTriageFeedback(page)
    await reportMetric(testInfo, 'bulk-archive-feedback', [feedbackMs], feedbackMs)
    expect(feedbackMs, '100-thread archive visual feedback').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
    await expect
      .poll(async () => Number(await list.getAttribute('data-thread-count')))
      .toBeGreaterThanOrEqual(THREAD_PAGE_SIZE)
    const loadedAfterArchive = Number(await list.getAttribute('data-thread-count'))
    expect(loadedAfterArchive).toBeLessThanOrEqual(loadedBeforeArchive + THREAD_PAGE_SIZE)
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()

    await page.keyboard.press('z')
    await expect
      .poll(async () => Number(await list.getAttribute('data-thread-count')))
      .toBeGreaterThanOrEqual(THREAD_PAGE_SIZE)
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()
  })

  test('opens and types in the composer within CI-safe ceilings', async ({ app, page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_PAGE_SIZE)
    )

    // Keep one-time renderer/JIT initialization visible in the metric while
    // enforcing the interaction budget against a stable, repeated hot path.
    const warmupSamples: number[] = []
    for (let iteration = 0; iteration < COMPOSER_OPEN_WARMUP_COUNT; iteration++) {
      warmupSamples.push(await measureComposerOpen(page))
      await expect(page.getByTestId('composer')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('composer')).toHaveCount(0)
    }

    const openSamples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      openSamples.push(await measureComposerOpen(page))
      await expect(page.getByTestId('composer')).toBeVisible()
      if (iteration < SAMPLE_COUNT - 1) {
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('composer')).toHaveCount(0)
      }
    }
    const openMedianMs = median(openSamples)
    await reportMetric(testInfo, 'composer-open', openSamples, openMedianMs, warmupSamples)
    expect(openMedianMs, 'median c keydown to composer mounted').toBeLessThan(COMPOSER_OPEN_CEILING_MS)

    // Target the authored body line. A center click can land in the protected
    // "Sent with Attn" footer, where autocomplete is intentionally disabled.
    await page.getByTestId('composer-editor').click({ position: { x: 24, y: 24 } })
    const mutationSamples: number[] = []
    const paintSamples: number[] = []
    const paintDeltaSamples: number[] = []
    for (const key of ['a', 't', 't', 'n', '.', 'c', 'o', 'm', 'p', 's']) {
      const sample = await measureComposerKeystroke(page, key)
      mutationSamples.push(sample.mutationMs)
      paintSamples.push(sample.paintMs)
      paintDeltaSamples.push(sample.paintDeltaMs)
    }
    const mutationMedianMs = median(mutationSamples)
    const paintMedianMs = median(paintSamples)
    const paintDeltaMedianMs = median(paintDeltaSamples)
    await reportMetric(testInfo, 'composer-keystroke-mutation', mutationSamples, mutationMedianMs)
    await reportMetric(testInfo, 'composer-keystroke-paint', paintSamples, paintMedianMs)
    await reportMetric(testInfo, 'composer-keystroke-paint-delta', paintDeltaSamples, paintDeltaMedianMs)
    expect(mutationMedianMs, 'median key input to editor mutation').toBeLessThan(COMPOSER_MUTATION_CEILING_MS)
    expect(percentile(paintDeltaSamples, 0.95), 'p95 editor mutation to next paint').toBeLessThan(
      COMPOSER_PAINT_DELTA_P95_CEILING_MS
    )

    // T37A: autocomplete on with a slow fake provider — requests overlap the
    // typing pauses, and keystrokes must stay within the same ceilings.
    await page.evaluate(async () => {
      await window.attn.ai.setKey('sk-perf-test')
      await window.attn.ai.setSetting('enabled', true)
      await window.attn.ai.setSetting('autocompleteEnabled', true)
    })
    const installFakeAi = (script: unknown): Promise<string | undefined> =>
      app.evaluate(
        ({ ipcMain }, input) =>
          new Promise<string | undefined>((resolve) =>
            ipcMain.emit(input.channel, {}, input.script, resolve)
          ),
        { channel: TEST_CHANNELS.installFakeAiProvider, script }
      )
    await installFakeAi({ chunks: [' and the follow-up plan.'], delayMs: 250 })
    const acMutationSamples: number[] = []
    const acPaintDeltaSamples: number[] = []
    for (const key of ['w', 'e', ' ', 's', 'h', 'o', 'u', 'l', 'd', ' ']) {
      const sample = await measureComposerKeystroke(page, key)
      acMutationSamples.push(sample.mutationMs)
      acPaintDeltaSamples.push(sample.paintDeltaMs)
    }
    const acMutationMedianMs = median(acMutationSamples)
    await reportMetric(
      testInfo,
      'composer-keystroke-mutation-autocomplete',
      acMutationSamples,
      acMutationMedianMs
    )
    expect(acMutationMedianMs, 'median keystroke mutation with autocomplete enabled').toBeLessThan(
      COMPOSER_MUTATION_CEILING_MS
    )
    expect(
      percentile(acPaintDeltaSamples, 0.95),
      'p95 mutation to paint with autocomplete enabled'
    ).toBeLessThan(COMPOSER_PAINT_DELTA_P95_CEILING_MS)

    // Acceptance-to-paint: a visible suggestion accepted with Tab lands in
    // the editor within the same frame budget as ordinary typing.
    await installFakeAi({ chunks: [' with the launch checklist attached.'] })
    // Sit out the controller's one-start-per-second cooldown. A fake clock
    // would fake `performance.now()` too and corrupt every sample in this
    // file, so the wait stays real — but derived from the constant it is
    // keyed to rather than a number that silently rots when that changes.
    await page.waitForTimeout(AUTOCOMPLETE_MIN_START_INTERVAL_MS + 100)
    await page.keyboard.type('t')
    await expect(page.getByTestId('ai-autocomplete-preview')).toBeVisible()
    const acceptance = await measureComposerAcceptance(page)
    await reportMetric(testInfo, 'composer-autocomplete-accept', [acceptance.paintMs], acceptance.paintMs)
    expect(acceptance.mutationMs, 'Tab acceptance to editor mutation').toBeLessThan(
      COMPOSER_MUTATION_CEILING_MS
    )
    expect(acceptance.paintDeltaMs, 'Tab acceptance mutation to paint').toBeLessThan(
      COMPOSER_PAINT_DELTA_P95_CEILING_MS
    )
  })
})
