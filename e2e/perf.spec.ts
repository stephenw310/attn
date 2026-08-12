import { expect, test } from './electron'

test.use({ seed: '.artifacts/perf-seed.json' })

test('@perf renders and triages a 2,000-thread inbox within CI-safe ceilings', async ({ page }) => {
  const renderMs = await page.evaluate(async () => {
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

  await expect(page.getByTestId('thread-row')).toHaveCount(2_000)
  expect(renderMs, 'navigation start to all list rows mounted').toBeLessThan(1_500)

  const openMs = await page.evaluate(async () => {
    const expected = 'Performance thread 2000'
    const subjectIsReady = (): boolean =>
      document.querySelector('[data-testid="conversation-subject"]')?.textContent === expected
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    if (subjectIsReady()) return performance.now() - started

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out opening the cached conversation'))
      }, 2_000)
      const observer = new MutationObserver(() => {
        if (!subjectIsReady()) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - started)
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    })
  })

  expect(openMs, 'Enter to cached conversation content mounted').toBeLessThan(200)

  const triageMs = await page.evaluate(async () => {
    const initialCount = document.querySelectorAll('[data-testid="thread-row"]').length
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))

    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Timed out waiting for triage feedback'))
      }, 2_000)
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll('[data-testid="thread-row"]').length >= initialCount) return
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

  expect(triageMs, 'e keydown to selected row removed').toBeLessThan(100)
  await expect(page.getByTestId('thread-row')).toHaveCount(1_999)
})
