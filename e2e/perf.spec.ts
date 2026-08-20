import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron'

const SAMPLE_COUNT = 5
const THREAD_COUNT = 10_000
const PERF_TEST_TIMEOUT_MS = 120_000
const LIST_RENDER_CEILING_MS = 2_000
const LOCAL_REFRESH_CEILING_MS = 2_000
const CONVERSATION_OPEN_CEILING_MS = 50
const TRIAGE_FEEDBACK_CEILING_MS = 16
const SCROLL_FRAME_P95_CEILING_MS = 20
const COMPOSER_OPEN_WARMUP_COUNT = 2
const COMPOSER_OPEN_CEILING_MS = 50
const COMPOSER_MUTATION_CEILING_MS = 8
const COMPOSER_PAINT_P95_CEILING_MS = 20
const MEMORY_CEILING_MB = 500

test.use({ seed: '.artifacts/perf-seed.json' })
// GitHub's Linux runner can spend close to the ordinary 30-second test timeout
// importing the 10,000-thread seed before a metric starts. Keep the measured
// interaction ceilings strict while giving fixture setup and teardown headroom.
// A retry would hide the instability this smoke is intended to expose.
test.describe.configure({ retries: 0, timeout: PERF_TEST_TIMEOUT_MS })

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

async function measureListRender(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const listIsReady = (): boolean =>
      document.querySelector('[data-testid="thread-list"]')?.getAttribute('data-thread-count') === '10000'
    if (listIsReady()) return performance.now()

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out before the 10,000-thread list became readable'))
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

async function measureLocalMailRefresh(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = performance.now()
    await Promise.all([
      window.attn.mail.listThreads(),
      window.attn.mail.listSnoozed(),
      window.attn.draft.list(),
      window.attn.outbox.listPending(),
      window.attn.mail.listLabels(),
      window.attn.mail.getUnreadCount(),
      window.attn.mail.getPendingActionCount(),
      window.attn.mail.getActionQueueStatus()
    ])
    return performance.now() - started
  })
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
): Promise<{ mutationMs: number; paintMs: number }> {
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
  return {
    mutationMs: Number(await editor.getAttribute('data-keystroke-mutation-ms')),
    paintMs: Number(await editor.getAttribute('data-keystroke-paint-ms'))
  }
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

test.describe('@perf 10,000-thread inbox', () => {
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

  test('windows the list and sustains scroll-frame pacing inside the memory budget', async ({
    app,
    page
  }, testInfo) => {
    const list = page.getByTestId('thread-list')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
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
    // process, so summing them badly overstates memory owned by Attn. The main
    // process private figure includes SQLite and other native allocations; the
    // renderer heap captures the 10k-thread model. The virtualized DOM remains
    // separately bounded by the row-count assertion above.
    const mainPrivateKb = await app.evaluate(async () => (await process.getProcessMemoryInfo()).private)
    const rendererHeapBytes = await page.evaluate(
      () =>
        (
          performance as Performance & {
            memory?: { usedJSHeapSize: number }
          }
        ).memory?.usedJSHeapSize ?? 0
    )
    expect(rendererHeapBytes, 'Chromium renderer heap measurement is available').toBeGreaterThan(0)
    const memoryMb = Math.round(mainPrivateKb / 1024 + rendererHeapBytes / 1024 / 1024)
    const memoryResult = {
      applicationOwnedMemoryMb: memoryMb,
      mainPrivateMb: Math.round(mainPrivateKb / 1024),
      rendererHeapMb: Math.round(rendererHeapBytes / 1024 / 1024),
      ceilingMb: MEMORY_CEILING_MB
    }
    console.log(`[perf] ${JSON.stringify({ name: 'steady-state-memory', ...memoryResult })}`)
    await testInfo.attach('steady-state-memory', {
      body: JSON.stringify(memoryResult, null, 2),
      contentType: 'application/json'
    })
    expect(memoryMb, 'main private memory plus renderer JS heap').toBeLessThan(MEMORY_CEILING_MB)
  })

  test('opens mounted conversation content within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
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

  test('refreshes the 10k local mail snapshot within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureLocalMailRefresh(page))
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'local-mail-refresh', samples, medianMs)
    expect(medianMs, 'median full local snapshot refresh').toBeLessThan(LOCAL_REFRESH_CEILING_MS)
  })

  test('removes triaged rows within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureTriageFeedback(page))
      await expect(page.getByTestId('thread-list')).toHaveAttribute(
        'data-thread-count',
        String(THREAD_COUNT - iteration - 1)
      )
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'triage-feedback', samples, medianMs)
    expect(medianMs, 'median e keydown to selected row removed').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
    await expect(page.getByTestId('thread-list')).toHaveAttribute(
      'data-thread-count',
      String(THREAD_COUNT - SAMPLE_COUNT)
    )
  })

  test('archives and reverses a 100-thread selection without missing the feedback budget', async ({
    page
  }, testInfo) => {
    const list = page.getByTestId('thread-list')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
    await page.evaluate(() => {
      window.addEventListener('error', (event) => {
        document.documentElement.dataset.perfReactError = event.error?.stack ?? event.message
      })
    })
    await page.keyboard.press('x')
    for (let index = 1; index < 100; index++) await page.keyboard.press('Shift+j')
    await expect(page.getByTestId('selection-count')).toHaveText('100 selected')
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()

    const feedbackMs = await measureTriageFeedback(page)
    await reportMetric(testInfo, 'bulk-archive-feedback', [feedbackMs], feedbackMs)
    expect(feedbackMs, '100-thread archive visual feedback').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_COUNT - 100))
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()

    await page.keyboard.press('z')
    await expect(list).toHaveAttribute('data-thread-count', String(THREAD_COUNT))
    expect(await page.locator('html').getAttribute('data-perf-react-error')).toBeNull()
  })

  test('opens and types in the composer within CI-safe ceilings', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', String(THREAD_COUNT))

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

    await page.getByTestId('composer-editor').click()
    const mutationSamples: number[] = []
    const paintSamples: number[] = []
    for (const key of ['a', 't', 't', 'n', '.']) {
      const sample = await measureComposerKeystroke(page, key)
      mutationSamples.push(sample.mutationMs)
      paintSamples.push(sample.paintMs)
    }
    const mutationMedianMs = median(mutationSamples)
    const paintMedianMs = median(paintSamples)
    await reportMetric(testInfo, 'composer-keystroke-mutation', mutationSamples, mutationMedianMs)
    await reportMetric(testInfo, 'composer-keystroke-paint', paintSamples, paintMedianMs)
    expect(mutationMedianMs, 'median key input to editor mutation').toBeLessThan(COMPOSER_MUTATION_CEILING_MS)
    expect(percentile(paintSamples, 0.95), 'p95 key input to next paint').toBeLessThan(
      COMPOSER_PAINT_P95_CEILING_MS
    )
  })
})
