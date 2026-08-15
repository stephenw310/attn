import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './electron'

const SAMPLE_COUNT = 5
const LIST_RENDER_CEILING_MS = 1_500
const CONVERSATION_OPEN_CEILING_MS = 1_500
const TRIAGE_FEEDBACK_CEILING_MS = 2_500
const COMPOSER_OPEN_WARMUP_COUNT = 2
const COMPOSER_OPEN_CEILING_MS = 150
const COMPOSER_KEYSTROKE_CEILING_MS = 250

test.use({ seed: '.artifacts/perf-seed.json' })
// A retry would hide the instability this smoke is intended to expose.
test.describe.configure({ retries: 0 })

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
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
    medianMs: Math.round(medianMs)
  }
  console.log(`[perf] ${JSON.stringify(result)}`)
  await testInfo.attach(`${name}-samples`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json'
  })
}

async function measureListRender(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const countRows = (): number => document.querySelectorAll('[data-testid="thread-row"]').length
    if (countRows() === 2_000) return performance.now()

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error(`Timed out with ${countRows()} rows rendered`))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (countRows() !== 2_000) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now())
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
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
    const countRows = (): number => document.querySelectorAll('[data-testid="thread-row"]').length
    const initialCount = countRows()
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out waiting for triage feedback'))
      }, 10_000)
      const observer = new MutationObserver(() => {
        if (countRows() >= initialCount) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(document.querySelector('[data-testid="thread-list"]') ?? document.body, {
        childList: true,
        subtree: true
      })
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

async function measureComposerKeystroke(page: Page, key: string): Promise<number> {
  const editor = page.getByTestId('composer-editor')
  await editor.evaluate((element) => {
    delete element.dataset.keystrokePaintMs
    const started = performance.now()
    const observer = new MutationObserver(() => {
      observer.disconnect()
      requestAnimationFrame(() => {
        element.dataset.keystrokePaintMs = String(performance.now() - started)
      })
    })
    observer.observe(element, { characterData: true, childList: true, subtree: true })
  })
  await page.keyboard.type(key)
  await expect.poll(() => editor.getAttribute('data-keystroke-paint-ms')).not.toBeNull()
  return Number(await editor.getAttribute('data-keystroke-paint-ms'))
}

test.describe('@perf 2,000-thread inbox', () => {
  test('renders the list within the CI-safe ceiling', async ({ boot, page }, testInfo) => {
    const samples: number[] = []
    let currentPage = page
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureListRender(currentPage))
      if (iteration < SAMPLE_COUNT - 1) currentPage = (await boot.relaunch()).page
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'list-render', samples, medianMs)
    expect(medianMs, 'median navigation start to all list rows mounted').toBeLessThan(LIST_RENDER_CEILING_MS)
  })

  test('opens mounted conversation content within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(2_000)
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

  test('removes triaged rows within the CI-safe ceiling', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(2_000)
    const samples: number[] = []
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      samples.push(await measureTriageFeedback(page))
    }

    const medianMs = median(samples)
    await reportMetric(testInfo, 'triage-feedback', samples, medianMs)
    expect(medianMs, 'median e keydown to selected row removed').toBeLessThan(TRIAGE_FEEDBACK_CEILING_MS)
    await expect(page.getByTestId('thread-row')).toHaveCount(2_000 - SAMPLE_COUNT)
  })

  test('opens and types in the composer within CI-safe ceilings', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(2_000)

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
    const samples: number[] = []
    for (const key of ['a', 't', 't', 'n', '.']) {
      samples.push(await measureComposerKeystroke(page, key))
    }
    const medianMs = median(samples)
    await reportMetric(testInfo, 'composer-keystroke-paint', samples, medianMs)
    expect(medianMs, 'median key input to next paint').toBeLessThan(COMPOSER_KEYSTROKE_CEILING_MS)
  })
})
