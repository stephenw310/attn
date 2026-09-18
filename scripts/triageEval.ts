// Dogfood eval for smart splits: measure how the shipped judgment payloads
// score against real mail, so `SPLIT_TRIAGE_THRESHOLD` and the question
// wording are set from evidence rather than guessed.
//
// This is a developer tool. It reads a local profile database read-only, sends
// the same state and questions the classifier sends, and writes the answers to
// a TSV under e2e/.generated/ (ignored by git). The TSV holds subjects and
// senders from real mail; keep it local. The key comes from TYPESAFE_API_KEY
// and is never printed. `scripts/triage-eval.mjs` bundles and runs this file.
//
// Usage:
//   node scripts/triage-eval.mjs judge --splits splits.json [--db path] [--account email]
//        [--limit 100] [--concurrency 4] [--out e2e/.generated/triage-eval.tsv] [--dry-run]
//   node scripts/triage-eval.mjs score --labels e2e/.generated/triage-eval.tsv
//
// splits.json: [{ "name": "Receipts", "description": "Bills I have to pay" }, ...]
// After `judge`, fill the `truth` column with the split names that truly apply,
// separated by `;`, or leave it empty for none. Then run `score`.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { judgeThread, TypeSafeAuthError, TypeSafeRateLimitError } from '../src/main/ai/typesafeClient'
import type { Db } from '../src/main/db'
import { readTriageThread } from '../src/main/sync/splitTriage'
import {
  buildTriageQuestions,
  buildTriageState,
  type TriageRule,
  type TriageThreadInput
} from '../src/main/sync/splitTriageState'
import { SPLIT_TRIAGE_THRESHOLD } from '../src/main/sync/tuning'
import { systemTime } from '../src/main/time'

const DEFAULT_DB = join(homedir(), 'Library', 'Application Support', 'ATTN', 'attn.db')
const DEFAULT_OUT = 'e2e/.generated/triage-eval.tsv'
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]

interface Args {
  command: string
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const [command = '', ...rest] = argv
  const flags = new Map<string, string | true>()
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (!token.startsWith('--')) continue
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) flags.set(token.slice(2), true)
    else {
      flags.set(token.slice(2), next)
      index++
    }
  }
  return { command, flags }
}

function flagText(args: Args, name: string, fallback: string): string {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : fallback
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const parsed = Number(flagText(args, name, String(fallback)))
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function collapse(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

interface ThreadSample {
  threadId: string
  input: TriageThreadInput
}

/** The newest Inbox threads, read through the pass's own loader so the evidence matches production. */
function loadSamples(db: Database.Database, accountId: string, limit: number): ThreadSample[] {
  const threads = db
    .prepare(
      `SELECT t.id
       FROM threads t
       JOIN thread_labels inbox
         ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
       WHERE t.account_id = ? AND t.is_inbox_visible = 1
       ORDER BY COALESCE(t.last_msg_at, 0) DESC, t.id DESC
       LIMIT ?`
    )
    .all(accountId, limit) as { id: string }[]
  const samples: ThreadSample[] = []
  for (const thread of threads) {
    const input = readTriageThread(db as unknown as Db, accountId, thread.id)
    if (input) samples.push({ threadId: thread.id, input })
  }
  return samples
}

function loadRules(path: string): TriageRule[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('splits.json must be a non-empty array')
  return parsed.map((entry, index) => {
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || typeof description !== 'string') {
      throw new Error(`splits.json entry ${index} needs name and description strings`)
    }
    const text = collapse(description)
    return {
      splitId: `eval:${index}`,
      name: collapse(name),
      description: text,
      descriptionHash: createHash('sha256').update(text).digest('hex')
    }
  })
}

async function judgeWithRetry(
  request: Parameters<typeof judgeThread>[0],
  log: (line: string) => void
): Promise<Record<string, number>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await judgeThread(request)
    } catch (error) {
      if (error instanceof TypeSafeRateLimitError && attempt < 4) {
        const waitMs = error.retryAfterMs ?? 1_000 * 2 ** (attempt - 1)
        log(`rate limited, waiting ${waitMs} ms`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
      throw error
    }
  }
}

async function judge(args: Args): Promise<number> {
  const dryRun = args.flags.get('dry-run') === true
  const key = process.env.TYPESAFE_API_KEY ?? ''
  if (!dryRun && key.length === 0) {
    console.error('Set TYPESAFE_API_KEY in your shell before running judge (or pass --dry-run).')
    return 2
  }
  const splitsPath = args.flags.get('splits')
  if (typeof splitsPath !== 'string') {
    console.error('judge needs --splits <splits.json>')
    return 2
  }
  const rules = loadRules(splitsPath)
  const dbPath = flagText(args, 'db', DEFAULT_DB)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: string }[]
    const accountId = flagText(args, 'account', accounts[0]?.id ?? '')
    if (!accounts.some((account) => account.id === accountId)) {
      console.error(`No such account. Known: ${accounts.map((account) => account.id).join(', ') || 'none'}`)
      return 2
    }
    const samples = loadSamples(db, accountId, flagNumber(args, 'limit', 100))
    const { questions, targets } = buildTriageQuestions(rules)
    console.log(`Account ${accountId}: ${samples.length} Inbox threads, ${rules.length} described splits`)

    if (dryRun) {
      const sample = samples[0]
      if (sample) {
        console.log('\nExample state:')
        console.log(JSON.stringify(buildTriageState(sample.input), null, 2))
      }
      console.log('\nQuestions:')
      console.log(JSON.stringify(questions, null, 2))
      console.log('\nDry run: nothing was sent.')
      return 0
    }

    const results = new Map<string, Record<string, number>>()
    let failures = 0
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const sample = samples[next++]
        if (!sample) return
        try {
          const probabilities = await judgeWithRetry(
            {
              key,
              model: flagText(args, 'model', 'jev-latest'),
              state: buildTriageState(sample.input),
              questions,
              transport: fetch,
              time: systemTime
            },
            (line) => console.log(`[${sample.threadId}] ${line}`)
          )
          results.set(sample.threadId, probabilities)
          process.stdout.write(`\r${results.size}/${samples.length} judged`)
        } catch (error) {
          if (error instanceof TypeSafeAuthError) throw error
          failures++
          console.log(`\n[${sample.threadId}] failed: ${error instanceof Error ? error.message : 'error'}`)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: flagNumber(args, 'concurrency', 4) }, () => worker()))
    } catch (error) {
      if (error instanceof TypeSafeAuthError) {
        console.error('\nThe service refused the key. Check TYPESAFE_API_KEY.')
        return 1
      }
      throw error
    }
    console.log(`\n${results.size} judged, ${failures} failed`)

    const header = ['thread_id', 'sender', 'subject', ...rules.map((rule) => `p:${rule.name}`), 'truth']
    const lines = [header.join('\t')]
    for (const sample of samples) {
      const probabilities = results.get(sample.threadId)
      if (!probabilities) continue
      const state = buildTriageState(sample.input)
      const cells = [
        sample.threadId,
        collapse(`${state.sender.name} <${state.sender.address}>`),
        collapse(state.subject).slice(0, 120),
        ...Object.keys(targets).map((id) => (probabilities[id] ?? 0).toFixed(3)),
        ''
      ]
      lines.push(cells.map((cell) => cell.replace(/[\t\r\n]/g, ' ')).join('\t'))
    }
    const out = flagText(args, 'out', DEFAULT_OUT)
    writeFileSync(out, `${lines.join('\n')}\n`)
    console.log(`Wrote ${out} (real subjects and senders; keep it local).`)

    for (const [index, rule] of rules.entries()) {
      const id = `s${index}`
      const scored = samples
        .map((sample) => ({ sample, p: results.get(sample.threadId)?.[id] }))
        .filter((entry): entry is { sample: ThreadSample; p: number } => typeof entry.p === 'number')
        .sort((left, right) => right.p - left.p)
      const claimed = scored.filter((entry) => entry.p >= SPLIT_TRIAGE_THRESHOLD).length
      console.log(`\n== ${rule.name}: ${claimed}/${scored.length} at or above ${SPLIT_TRIAGE_THRESHOLD}`)
      const buckets = new Array<number>(10).fill(0)
      for (const entry of scored) buckets[Math.min(9, Math.floor(entry.p * 10))]++
      console.log(`   histogram 0.0→1.0: ${buckets.join(' ')}`)
      for (const entry of scored.slice(0, 12)) {
        const state = buildTriageState(entry.sample.input)
        console.log(
          `   ${entry.p.toFixed(2)}  ${state.sender.address.padEnd(32).slice(0, 32)}  ${state.subject.slice(0, 60)}`
        )
      }
    }
    console.log('\nNext: fill the truth column in the TSV, then run score --labels <tsv>.')
    return 0
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

function score(args: Args): number {
  const labelsPath = args.flags.get('labels')
  if (typeof labelsPath !== 'string') {
    console.error('score needs --labels <tsv written by judge, with the truth column filled>')
    return 2
  }
  const rows = readFileSync(labelsPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
  const header = rows.shift() ?? []
  const splitColumns = header
    .map((name, index) => ({ name, index }))
    .filter((column) => column.name.startsWith('p:'))
    .map((column) => ({ name: column.name.slice(2), index: column.index }))
  const truthIndex = header.indexOf('truth')
  if (splitColumns.length === 0 || truthIndex < 0) {
    console.error('The TSV does not look like judge output.')
    return 2
  }
  console.log(`${rows.length} labeled threads, ${splitColumns.length} splits\n`)
  const bestOverall = new Map<number, number>()
  for (const column of splitColumns) {
    console.log(`== ${column.name}`)
    console.log('   thr   claimed  precision  recall  f1')
    let best: { threshold: number; f1: number } | null = null
    for (const threshold of THRESHOLDS) {
      let tp = 0
      let fp = 0
      let fn = 0
      for (const row of rows) {
        const p = Number(row[column.index] ?? '0')
        const truth = (row[truthIndex] ?? '')
          .split(';')
          .map((name) => collapse(name).toLowerCase())
          .filter(Boolean)
        const actual = truth.includes(column.name.toLowerCase())
        const claimed = p >= threshold
        if (claimed && actual) tp++
        else if (claimed) fp++
        else if (actual) fn++
      }
      const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
      const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
      const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
      bestOverall.set(threshold, (bestOverall.get(threshold) ?? 0) + f1)
      if (!best || f1 > best.f1) best = { threshold, f1 }
      console.log(
        `   ${threshold.toFixed(2)}  ${String(tp + fp).padStart(7)}  ${precision.toFixed(2).padStart(9)}  ${recall
          .toFixed(2)
          .padStart(6)}  ${f1.toFixed(2)}`
      )
    }
    if (best) console.log(`   best F1 ${best.f1.toFixed(2)} at ${best.threshold.toFixed(2)}\n`)
  }
  const overall = [...bestOverall.entries()].sort((left, right) => right[1] - left[1])[0]
  if (overall) {
    console.log(
      `Overall: threshold ${overall[0].toFixed(2)} has the best summed F1. ` +
        `Current SPLIT_TRIAGE_THRESHOLD is ${SPLIT_TRIAGE_THRESHOLD}.`
    )
  }
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === 'judge') return judge(args)
  if (args.command === 'score') return score(args)
  console.error(
    'Usage: node scripts/triage-eval.mjs judge --splits <json> [--dry-run] | score --labels <tsv>'
  )
  return 2
}
