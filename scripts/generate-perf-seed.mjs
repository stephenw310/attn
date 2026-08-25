#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
const output = join(ROOT, outputArgument?.slice('--output='.length) ?? 'e2e/.artifacts/perf-seed.json')
const messageArgument = process.argv.find((argument) => argument.startsWith('--messages='))
const messageCount = Number(messageArgument?.slice('--messages='.length) ?? 10_000)
if (!Number.isSafeInteger(messageCount) || messageCount < 1) {
  throw new Error('--messages must be a positive integer')
}
const threadCount = Math.min(10_000, messageCount)
const baseDate = Date.UTC(2026, 0, 1)

const threads = Array.from({ length: threadCount }, (_, index) => {
  const number = index + 1
  return {
    id: `perf-thread-${number}`,
    historyId: String(10_000 + number),
    messages: Array.from(
      {
        length: Math.floor(messageCount / threadCount) + (index < messageCount % threadCount ? 1 : 0)
      },
      (_, messageIndex) => {
        const messageNumber = index + 1 + messageIndex * threadCount
        return {
          id: `perf-message-${messageNumber}`,
          labelIds: ['INBOX', ...(number % 2 === 0 ? ['UNREAD'] : [])],
          internalDate: String(baseDate + messageNumber * 60_000),
          from: `Sender ${number} <sender${number}@example.test>`,
          to: 'perf@attn.test',
          subject: `Performance thread ${number}`,
          snippet: `Deterministic performance fixture message ${messageNumber}.`,
          bodyText: `Cached conversation body for performance thread ${number}, message ${messageNumber}.`,
          ...(messageIndex === 0 && number <= 100
            ? {
                attachments: [
                  {
                    attachmentId: `perf-attachment-${number}`,
                    filename: `performance-${number}.pdf`,
                    mimeType: 'application/pdf',
                    sizeBytes: 1024
                  }
                ]
              }
            : {})
        }
      }
    )
  }
})

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify({ account: 'perf@attn.test', threads })}\n`)
console.log(`[perf-seed] wrote ${threadCount} threads and ${messageCount} messages to ${output}`)
