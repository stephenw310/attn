import { describe, expect, it, vi } from 'vitest'
import { formatSnoozeDate, parseSnoozeText } from '../../shared/snooze'
import { rankCommands, recordCommandUse } from './commandPalette'
import { createCommand } from './commands'

describe('command palette ranking', () => {
  it('keeps an exact prefix above a stronger fuzzy match', () => {
    const commands = [
      createCommand('view.starred', vi.fn(), { title: 'Go to Starred' }),
      createCommand('triage.star', vi.fn(), { title: 'Star' })
    ]
    expect(rankCommands(commands, 'list', 'star', {}).map((result) => result.command.id)).toEqual([
      'triage.star',
      'view.starred'
    ])
  })

  it('uses frequency and then recency to break equal ranking ties', () => {
    const commands = [createCommand('view.sent', vi.fn()), createCommand('view.starred', vi.fn())]
    const now = new Date(2026, 7, 25, 10).getTime()

    expect(
      rankCommands(commands, 'list', 'go to', {
        'view.sent': { count: 2, lastUsedAt: now },
        'view.starred': { count: 8, lastUsedAt: now }
      }).at(0)?.command.id
    ).toBe('view.starred')
    expect(
      rankCommands(commands, 'list', 'go to', {
        'view.sent': { count: 2, lastUsedAt: now },
        'view.starred': { count: 2, lastUsedAt: now - 86_400_000 }
      }).at(0)?.command.id
    ).toBe('view.sent')
  })

  it('filters list, reader, composer, and global commands by active context', () => {
    const commands = [
      createCommand('conversation.open', vi.fn()),
      createCommand('conversation.close', vi.fn()),
      createCommand('composer.send', vi.fn()),
      createCommand('search.open', vi.fn()),
      createCommand('search.allGmail', vi.fn()),
      createCommand('search.clear', vi.fn()),
      createCommand('view.inbox', vi.fn()),
      createCommand('composer.new', vi.fn()),
      createCommand('triage.undo', vi.fn())
    ]

    expect(rankCommands(commands, 'list', '', {}).map((result) => result.command.id)).toEqual([
      'conversation.open',
      'search.open',
      'search.allGmail',
      'search.clear',
      'view.inbox',
      'composer.new',
      'triage.undo'
    ])
    expect(rankCommands(commands, 'reader', '', {}).map((result) => result.command.id)).toEqual([
      'conversation.close',
      'search.open',
      'search.allGmail',
      'search.clear',
      'view.inbox',
      'composer.new',
      'triage.undo'
    ])
    expect(rankCommands(commands, 'composer', '', {}).map((result) => result.command.id)).toEqual([
      'view.inbox',
      'composer.send'
    ])
  })

  it('parses an inline snooze argument through the shared parser', () => {
    const now = new Date(2026, 7, 25, 10).getTime()
    const run = vi.fn()
    const command = createCommand('triage.snooze', vi.fn(), {
      argument: {
        prefixes: ['remind me', 'snooze'],
        parse: (input) => {
          const dueAt = parseSnoozeText(input, now)
          return dueAt ? { label: `Snooze until ${formatSnoozeDate(dueAt)}`, value: dueAt } : null
        },
        run
      }
    })

    const result = rankCommands([command], 'list', 'remind me tomorrow 9am', {}).at(0)
    expect(result?.match).toBe('prefix')
    expect(result?.title).toContain('Snooze until')
    command.argument?.run(result?.argument?.value)
    expect(run).toHaveBeenCalledWith(new Date(2026, 7, 26, 9).getTime())
  })

  it('records bounded usage without mutating the previous value', () => {
    const current = { 'view.inbox': { count: 2, lastUsedAt: 100 } }
    const next = recordCommandUse(current, 'view.inbox', 200)
    expect(next['view.inbox']).toEqual({ count: 3, lastUsedAt: 200 })
    expect(current['view.inbox']).toEqual({ count: 2, lastUsedAt: 100 })
  })
})
