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
// The 10,000-thread profile answers list, scroll, and triage budgets. The scale
// profile exists for a different failure: a read whose cost grows with the store.
// Those stay invisible at 10,000 rows — the account scan this suite was extended
// to catch measured under a millisecond there and half a second at a million.
const threadArgument = process.argv.find((argument) => argument.startsWith('--threads='))
const requestedThreads = Number(threadArgument?.slice('--threads='.length) ?? 10_000)
if (!Number.isSafeInteger(requestedThreads) || requestedThreads < 1) {
  throw new Error('--threads must be a positive integer')
}
const threadCount = Math.min(requestedThreads, messageCount)
const baseDate = Date.UTC(2026, 0, 1)

// Opt-in, because the shipped 10,000-thread profile's budgets are written
// against an all-Inbox mailbox and spreading it would move them. The scale
// profile needs the spread instead: a mailbox that is all Inbox lets an All Mail
// regression hide behind an Inbox-shaped index.
const spreadLabels = process.argv.includes('--spread-labels')

/**
 * Sent mail records one contact per recipient, and contact statistics are
 * recomputed for each address a write touches. Addressing every sent message to
 * the same person therefore makes importing the profile quadratic — 100,000
 * threads did not finish in fifteen minutes. Real sent mail spreads across
 * correspondents, so the profile does too.
 */
function recipientFor(number) {
  return spreadLabels ? `Recipient ${number % 500} <recipient${number % 500}@example.test>` : 'perf@attn.test'
}

function labelsFor(number) {
  if (!spreadLabels) return ['INBOX', ...(number % 2 === 0 ? ['UNREAD'] : [])]
  const bucket = number % 100
  if (bucket < 40) return ['INBOX', ...(number % 2 === 0 ? ['UNREAD'] : [])]
  if (bucket < 55) return ['SENT']
  if (bucket < 58) return ['STARRED']
  if (bucket === 58) return ['SPAM']
  if (bucket === 59) return ['TRASH']
  return ['CATEGORY_UPDATES']
}

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
          labelIds: labelsFor(number),
          internalDate: String(baseDate + messageNumber * 60_000),
          from: `Sender ${number} <sender${number}@example.test>`,
          to: recipientFor(number),
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
