#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(ROOT, 'e2e/.artifacts/perf-seed.json')
const threadCount = 2_000
const baseDate = Date.UTC(2026, 0, 1)

const threads = Array.from({ length: threadCount }, (_, index) => {
  const number = index + 1
  return {
    id: `perf-thread-${number}`,
    historyId: String(10_000 + number),
    messages: [
      {
        id: `perf-message-${number}`,
        labelIds: ['INBOX', ...(number % 2 === 0 ? ['UNREAD'] : [])],
        internalDate: String(baseDate + number * 60_000),
        from: `Sender ${number} <sender${number}@example.test>`,
        to: 'perf@attn.test',
        subject: `Performance thread ${number}`,
        snippet: `Deterministic performance fixture row ${number}.`,
        bodyText: `Cached conversation body for performance thread ${number}.`
      }
    ]
  }
})

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify({ account: 'perf@attn.test', threads })}\n`)
console.log(`[perf-seed] wrote ${threadCount} threads to ${output}`)
