import { type CommandUsage, sanitizeCommandUsage } from '../../shared/commandUsage'
import {
  type ActiveCommandContext,
  COMMAND_SPECS,
  type Command,
  type CommandArgumentValue,
  commandMatchesContext
} from './commands'

const COMMAND_ORDER = new Map(Object.keys(COMMAND_SPECS).map((id, index) => [id, index]))

export interface PaletteResult {
  command: Command
  title: string
  argument?: CommandArgumentValue
  match: 'empty' | 'prefix' | 'fuzzy'
}

interface ScoredResult extends PaletteResult {
  index: number
  score: number
  usageScore: number
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function fuzzyScore(haystack: string, needle: string): number | null {
  let previous = -1
  let score = 0
  for (const character of needle) {
    const index = haystack.indexOf(character, previous + 1)
    if (index < 0) return null
    const gap = index - previous - 1
    score += 10 - Math.min(gap, 8)
    if (index === 0 || /[\s/._-]/.test(haystack[index - 1] ?? '')) score += 6
    if (index === previous + 1) score += 4
    previous = index
  }
  return score - haystack.length / 100
}

function usageScore(usage: CommandUsage[string] | undefined, now: number): number {
  if (!usage) return 0
  const frequency = Math.min(24, Math.log2(usage.count + 1) * 4)
  const ageDays = Math.max(0, now - usage.lastUsedAt) / 86_400_000
  const recency = Math.max(0, 12 - ageDays / 2.5)
  return frequency + recency
}

function inlineArgument(command: Command, query: string): CommandArgumentValue | null {
  if (!command.argument) return null
  const input = query.trim()
  const folded = input.toLocaleLowerCase()
  for (const prefix of [...command.argument.prefixes].sort((left, right) => right.length - left.length)) {
    const normalizedPrefix = normalized(prefix)
    if (!folded.startsWith(`${normalizedPrefix} `)) continue
    const argumentText = input.slice(prefix.length).trim()
    if (!argumentText) continue
    try {
      return command.argument.parse(argumentText)
    } catch {
      return null
    }
  }
  return null
}

export function rankCommands(
  commands: readonly Command[],
  context: ActiveCommandContext,
  query: string,
  usage: CommandUsage,
  now = Date.now()
): PaletteResult[] {
  const foldedQuery = normalized(query)
  const scored = commands.flatMap<ScoredResult>((command) => {
    if (!commandMatchesContext(command, context)) return []
    const index = COMMAND_ORDER.get(command.id) ?? Number.MAX_SAFE_INTEGER
    const commandUsageScore = usageScore(usage[command.id], now)
    if (!foldedQuery) {
      return [
        { command, title: command.title, match: 'empty', score: 0, usageScore: commandUsageScore, index }
      ]
    }

    const argument = inlineArgument(command, query)
    if (argument) {
      return [
        {
          command,
          title: argument.label,
          argument,
          match: 'prefix',
          score: 1_000,
          usageScore: commandUsageScore,
          index
        }
      ]
    }

    const haystacks = [command.title, ...(command.argument?.prefixes ?? [])].map(normalized)
    const prefixScores = haystacks
      .filter((candidate) => candidate.startsWith(foldedQuery))
      .map((candidate) => 1_000 - (candidate.length - foldedQuery.length) / 100)
    if (prefixScores.length > 0) {
      return [
        {
          command,
          title: command.title,
          match: 'prefix',
          score: Math.max(...prefixScores),
          usageScore: commandUsageScore,
          index
        }
      ]
    }

    const fuzzyScores = haystacks
      .map((candidate) => fuzzyScore(candidate, foldedQuery))
      .filter((score): score is number => score !== null)
    if (fuzzyScores.length === 0) return []
    return [
      {
        command,
        title: command.title,
        match: 'fuzzy',
        score: Math.max(...fuzzyScores),
        usageScore: commandUsageScore,
        index
      }
    ]
  })

  const matchRank = { empty: 0, fuzzy: 1, prefix: 2 } as const
  scored.sort((left, right) => {
    const matchDifference = matchRank[right.match] - matchRank[left.match]
    if (matchDifference !== 0) return matchDifference
    const boostedScoreDifference = right.score + right.usageScore - (left.score + left.usageScore)
    if (Math.abs(boostedScoreDifference) > 0.001) return boostedScoreDifference
    return left.index - right.index
  })
  return scored
}

export function recordCommandUse(usage: CommandUsage, commandId: string, now = Date.now()): CommandUsage {
  const current = usage[commandId]
  return sanitizeCommandUsage({
    ...usage,
    [commandId]: {
      count: Math.min(Number.MAX_SAFE_INTEGER, (current?.count ?? 0) + 1),
      lastUsedAt: now
    }
  })
}
