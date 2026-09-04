#!/usr/bin/env node
// Prints the tests Playwright had to retry. CI runs with `retries: 1`, which
// turns a flake into a green job; the JSON reporter records it, and this makes
// the job log (and the step summary) say so. It never fails the step — the
// suite's own exit code decides that.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const report = process.argv[2] ?? 'e2e/.results/results.json'
if (!existsSync(report)) {
  console.log(`[flaky] no Playwright JSON report at ${report} — nothing to summarise`)
  process.exit(0)
}

const flaky = []
const walk = (suite, trail) => {
  const path = suite.title ? [...trail, suite.title] : trail
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status !== 'flaky') continue
      flaky.push(`${[...path, spec.title].join(' › ')} (${test.results?.length ?? 0} attempts)`)
    }
  }
  for (const child of suite.suites ?? []) walk(child, path)
}
for (const suite of JSON.parse(readFileSync(report, 'utf8')).suites ?? []) walk(suite, [])

const heading = flaky.length === 0 ? 'no flaky tests' : `${flaky.length} flaky test(s)`
console.log(`[flaky] ${heading}`)
for (const line of flaky) console.log(`[flaky]   - ${line}`)

const summary = process.env.GITHUB_STEP_SUMMARY
if (summary) {
  const lines = ['### Flaky tests', '', heading, ...flaky.map((line) => `- ${line}`), '']
  appendFileSync(summary, lines.join('\n'))
}
