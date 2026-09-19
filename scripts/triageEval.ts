// Dogfood eval for smart splits: measure how the shipped judgment payloads
// score against real mail, so `SPLIT_TRIAGE_THRESHOLD` and the question
// wording are set from evidence rather than guessed.
//
// This is a developer tool. It reads a local profile database read-only, sends
// the same packed state and questions the classifier sends, and writes the
// answers to a TSV under e2e/.generated/ (ignored by git). The TSV holds
// subjects and senders from real mail; keep it local. The key comes from
// TYPESAFE_API_KEY and is never printed. `scripts/triage-eval.mjs` bundles and
// runs this file.
//
// Usage:
//   node scripts/triage-eval.mjs judge --splits splits.json [--db path] [--account email]
//        [--limit 100] [--concurrency 4] [--out e2e/.generated/triage-eval.tsv] [--dry-run]
//   node scripts/triage-eval.mjs score --labels e2e/.generated/triage-eval.tsv
//   node scripts/triage-eval.mjs pack --splits splits.json --baseline <tsv from judge> [--size 10] [--dry-run]
//
// `judge` sends the shipped pack size. `pack` re-judges a baseline at a chosen
// --size and reports what the different packing changed.
//
// splits.json: [{ "name": "Receipts", "description": "Bills I have to pay" }, ...]
// After `judge`, fill the `truth` column with the split names that truly apply,
// separated by `;`, or leave it empty for none. Then run `score`.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { judgeThread, TypeSafeAuthError, TypeSafeRateLimitError } from '../src/main/ai/typesafeClient'
import type { Db } from '../src/main/db'
import { readTriageThread } from '../src/main/sync/splitTriage'
import {
  buildPackedTriageRequest,
  buildTriageState,
  type TriageRule,
  type TriageThreadInput
} from '../src/main/sync/splitTriageState'
import { SPLIT_TRIAGE_PACK_SIZE, SPLIT_TRIAGE_THRESHOLD } from '../src/main/sync/tuning'
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

/** The question the packed request asks about conversation `i` and rule `j`. */
function packedId(threadIndex: number, ruleIndex: number): string {
  return `t${threadIndex}_s${ruleIndex}`
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) groups.push([...items.slice(index, index + size)])
  return groups
}

/** How large the request body is, so a pack size can be judged before it is sent. */
function describeRequest(state: unknown, questionCount: number, threadCount: number): string {
  const json = JSON.stringify(state)
  return (
    `${threadCount} conversations, ${questionCount} questions, ` +
    `state ${json.length.toLocaleString()} chars ` +
    `(about ${Math.round(json.length / 4).toLocaleString()} tokens)`
  )
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
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist. Write a JSON array of { "name", "description" } entries, ` +
        'one per split you want to measure, then run judge again.'
    )
  }
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
    // `--ids a,b,c` judges exactly those threads, for reproducing a failed pack.
    const requestedIds = flagText(args, 'ids', '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    const samples =
      requestedIds.length > 0
        ? requestedIds.flatMap((threadId) => {
            const input = readTriageThread(db as unknown as Db, accountId, threadId)
            return input ? [{ threadId, input }] : []
          })
        : loadSamples(db, accountId, flagNumber(args, 'limit', 100))
    // The shipped shape: one request carries a pack of conversations.
    const groups = chunk(samples, SPLIT_TRIAGE_PACK_SIZE)
    console.log(
      `Account ${accountId}: ${samples.length} Inbox threads, ${rules.length} described splits, ` +
        `${groups.length} requests of up to ${SPLIT_TRIAGE_PACK_SIZE}`
    )

    if (dryRun) {
      const first = groups[0]
      if (first) {
        const request = buildPackedTriageRequest(
          first.map((sample) => buildTriageState(sample.input)),
          rules
        )
        console.log(
          `\nFirst request: ${describeRequest(request.state, Object.keys(request.questions).length, first.length)}`
        )
        console.log('\nExample conversation:')
        console.log(JSON.stringify(request.state.threads[0], null, 2))
        console.log('\nExample question:')
        console.log(JSON.stringify(request.questions[packedId(first.length - 1, 0)], null, 2))
      }
      console.log('\nDry run: nothing was sent.')
      return 0
    }

    // Per thread, keyed `s0`, `s1`, … by rule, so the TSV below reads the same
    // whatever the pack size is.
    const results = new Map<string, Record<string, number>>()
    let failures = 0
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        const group = groups[index]
        if (!group) return
        const request = buildPackedTriageRequest(
          group.map((sample) => buildTriageState(sample.input)),
          rules
        )
        try {
          const answers = await judgeWithRetry(
            {
              key,
              model: flagText(args, 'model', 'jev-latest'),
              state: request.state,
              questions: request.questions,
              transport: fetch,
              time: systemTime
            },
            (line) => console.log(`[request ${index}] ${line}`)
          )
          group.forEach((sample, threadIndex) => {
            results.set(
              sample.threadId,
              Object.fromEntries(
                rules.map((_, ruleIndex) => [`s${ruleIndex}`, answers[packedId(threadIndex, ruleIndex)] ?? 0])
              )
            )
          })
          process.stdout.write(`\r${results.size}/${samples.length} judged`)
        } catch (error) {
          if (error instanceof TypeSafeAuthError) throw error
          failures += group.length
          console.log(`\n[request ${index}] failed: ${error instanceof Error ? error.message : 'error'}`)
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
        ...rules.map((_, index) => (probabilities[`s${index}`] ?? 0).toFixed(3)),
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

// ---------------------------------------------------------------------------
// pack: try a different pack size against a baseline the shipped size produced
// ---------------------------------------------------------------------------

interface BaselineRow {
  threadId: string
  single: Record<string, number>
  truth: string[]
}

/** The TSV `judge` wrote, with or without a filled truth column. */
function readBaseline(path: string): { rows: BaselineRow[]; splitNames: string[] } {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
  const header = lines.shift() ?? []
  const columns = header
    .map((name, index) => ({ name, index }))
    .filter((column) => column.name.startsWith('p:'))
    .map((column) => ({ name: column.name.slice(2), index: column.index }))
  const truthIndex = header.indexOf('truth')
  if (header[0] !== 'thread_id' || columns.length === 0) throw new Error(`${path} is not judge output`)
  const rows = lines.map((cells) => ({
    threadId: cells[0] ?? '',
    single: Object.fromEntries(columns.map((column) => [column.name, Number(cells[column.index] ?? '0')])),
    truth:
      truthIndex >= 0
        ? (cells[truthIndex] ?? '')
            .split(';')
            .map((name) => collapse(name).toLowerCase())
            .filter(Boolean)
        : []
  }))
  return { rows, splitNames: columns.map((column) => column.name) }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function precisionRecall(
  rows: BaselineRow[],
  name: string,
  probabilityOf: (row: BaselineRow) => number | undefined
): string {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const row of rows) {
    const p = probabilityOf(row)
    if (p === undefined) continue
    const actual = row.truth.includes(name.toLowerCase())
    const claimed = p >= SPLIT_TRIAGE_THRESHOLD
    if (claimed && actual) tp++
    else if (claimed) fp++
    else if (actual) fn++
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return `P ${precision.toFixed(2)} R ${recall.toFixed(2)}`
}

async function pack(args: Args): Promise<number> {
  const dryRun = args.flags.get('dry-run') === true
  const key = process.env.TYPESAFE_API_KEY ?? ''
  if (!dryRun && key.length === 0) {
    console.error('Set TYPESAFE_API_KEY in your shell before running pack (or pass --dry-run).')
    return 2
  }
  const splitsPath = args.flags.get('splits')
  const baselinePath = args.flags.get('baseline')
  if (typeof splitsPath !== 'string' || typeof baselinePath !== 'string') {
    console.error('pack needs --splits <splits.json> --baseline <tsv from judge> [--size 10]')
    return 2
  }
  const rules = loadRules(splitsPath)
  const { rows, splitNames } = readBaseline(baselinePath)
  for (const rule of rules) {
    if (!splitNames.includes(rule.name)) {
      console.error(`The baseline has no p:${rule.name} column; use the splits file that produced it.`)
      return 2
    }
  }
  const size = flagNumber(args, 'size', 10)
  const dbPath = flagText(args, 'db', DEFAULT_DB)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: string }[]
    const accountId = flagText(args, 'account', accounts[0]?.id ?? '')
    const loaded = rows.flatMap((row) => {
      const input = readTriageThread(db, accountId, row.threadId)
      return input ? [{ row, state: buildTriageState(input) }] : []
    })
    console.log(
      `Account ${accountId}: ${loaded.length} of ${rows.length} baseline threads still stored, ` +
        `${rules.length} AI rules, ${size} threads per request`
    )
    const groups = chunk(loaded, size)

    if (dryRun) {
      const first = groups[0]
      if (first) {
        const request = buildPackedTriageRequest(
          first.map((entry) => entry.state),
          rules
        )
        console.log(
          `\nFirst request: ${describeRequest(request.state, Object.keys(request.questions).length, first.length)}`
        )
        console.log('Example question:')
        console.log(JSON.stringify(request.questions[packedId(Math.min(1, first.length - 1), 0)], null, 2))
      }
      console.log('\nDry run: nothing was sent.')
      return 0
    }

    const packed = new Map<string, Record<string, number>>()
    const position = new Map<string, number>()
    const startedAt = Date.now()
    let requests = 0
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        const group = groups[index]
        if (!group) return
        const request = buildPackedTriageRequest(
          group.map((entry) => entry.state),
          rules
        )
        try {
          const answers = await judgeWithRetry(
            {
              key,
              model: flagText(args, 'model', 'jev-latest'),
              state: request.state,
              questions: request.questions,
              transport: fetch,
              time: systemTime
            },
            (line) => console.log(`[group ${index}] ${line}`)
          )
          requests++
          group.forEach((entry, i) => {
            packed.set(
              entry.row.threadId,
              Object.fromEntries(rules.map((rule, j) => [rule.name, answers[packedId(i, j)] ?? 0]))
            )
            position.set(entry.row.threadId, i)
          })
          process.stdout.write(`\r${packed.size}/${loaded.length} judged in ${requests} requests`)
        } catch (error) {
          if (error instanceof TypeSafeAuthError) throw error
          console.log(`\n[group ${index}] failed: ${error instanceof Error ? error.message : 'error'}`)
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
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`\n${packed.size} threads in ${requests} requests, ${elapsed} s wall clock\n`)

    const judged = loaded.filter((entry) => packed.has(entry.row.threadId)).map((entry) => entry.row)
    const hasTruth = judged.some((row) => row.truth.length > 0)
    console.log(
      `split          n   mean|Δ|  max|Δ|  flips@0.7${hasTruth ? '   baseline        this size' : ''}`
    )
    for (const rule of rules) {
      const deltas = judged.map((row) => (packed.get(row.threadId)?.[rule.name] ?? 0) - row.single[rule.name])
      const flips = judged.filter(
        (row) =>
          row.single[rule.name] >= SPLIT_TRIAGE_THRESHOLD !==
          (packed.get(row.threadId)?.[rule.name] ?? 0) >= SPLIT_TRIAGE_THRESHOLD
      ).length
      const line =
        `${rule.name.padEnd(12)} ${String(judged.length).padStart(4)}   ` +
        `${mean(deltas.map(Math.abs)).toFixed(3)}   ${Math.max(0, ...deltas.map(Math.abs)).toFixed(3)}   ` +
        `${String(flips).padStart(9)}`
      const scored = hasTruth
        ? `   ${precisionRecall(judged, rule.name, (row) => row.single[rule.name])}   ` +
          precisionRecall(judged, rule.name, (row) => packed.get(row.threadId)?.[rule.name])
        : ''
      console.log(line + scored)
    }
    const byPosition = new Map<number, number[]>()
    for (const row of judged) {
      const at = position.get(row.threadId) ?? 0
      const deltas = rules.map((rule) =>
        Math.abs((packed.get(row.threadId)?.[rule.name] ?? 0) - row.single[rule.name])
      )
      byPosition.set(at, [...(byPosition.get(at) ?? []), ...deltas])
    }
    console.log('\nmean|Δ| by position in the request:')
    console.log(
      [...byPosition.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([at, deltas]) => `${at}:${mean(deltas).toFixed(3)}`)
        .join('  ')
    )
    return 0
  } finally {
    db.close()
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === 'judge') return judge(args)
  if (args.command === 'score') return score(args)
  if (args.command === 'pack') return pack(args)
  console.error(
    'Usage: node scripts/triage-eval.mjs judge --splits <json> [--dry-run] | score --labels <tsv> | ' +
      'pack --splits <json> --baseline <tsv> [--size 10] [--dry-run]'
  )
  return 2
}
