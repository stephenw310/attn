import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { ThreadPage } from '../../shared/mail'
import type { ServiceEvent, ServiceInitialize } from './protocol'
import { ServiceRuntime } from './runtime'

// Two seeded accounts prove the session-per-account runtime (F18): reads are
// answered for the active account only, the switch is durable, and the badge
// spans the roster. Seeded sessions never touch Gmail, so this runs hermetic.

const TWO_ACCOUNTS = {
  accounts: [
    {
      account: 'primary@attn.test',
      labels: [{ id: 'Label_A', name: 'receipts', type: 'user' }],
      threads: [
        {
          id: 't-alpha',
          messages: [
            {
              id: 'm-alpha',
              labelIds: ['INBOX', 'UNREAD'],
              receivedDaysAgo: 0,
              from: 'Ada <ada@example.com>',
              to: 'primary@attn.test',
              subject: 'Alpha roadmap',
              snippet: 'Alpha snippet',
              bodyText: 'Alpha body'
            }
          ]
        }
      ]
    },
    {
      account: 'second@attn.test',
      labels: [{ id: 'Label_B', name: 'launches', type: 'user' }],
      threads: [
        {
          id: 't-beta',
          messages: [
            {
              id: 'm-beta',
              labelIds: ['INBOX', 'UNREAD'],
              receivedDaysAgo: 0,
              from: 'Bea <bea@example.com>',
              to: 'second@attn.test',
              subject: 'Beta launch',
              snippet: 'Beta snippet',
              bodyText: 'Beta body'
            }
          ]
        },
        {
          id: 't-beta-2',
          messages: [
            {
              id: 'm-beta-2',
              labelIds: ['INBOX', 'UNREAD'],
              receivedDaysAgo: 1,
              from: 'Bea <bea@example.com>',
              to: 'second@attn.test',
              subject: 'Beta digest',
              snippet: 'Digest snippet',
              bodyText: 'Digest body'
            }
          ]
        }
      ]
    }
  ]
}

describe('ServiceRuntime with several accounts', () => {
  let dir: string | null = null
  let runtimes: ServiceRuntime[] = []

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.stop()
    runtimes = []
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeInput(): ServiceInitialize {
    dir ??= mkdtempSync(join(tmpdir(), 'attn-runtime-test-'))
    const seedPath = join(dir, 'seed.json')
    writeFileSync(seedPath, JSON.stringify(TWO_ACCOUNTS))
    return {
      protocolVersion: 3,
      dbPath: join(dir, 'attn.db'),
      userDataPath: dir,
      downloadsPath: dir,
      testMode: true,
      testSeed: seedPath,
      accounts: { config: null, accounts: [], activeAccountId: null },
      focused: false
    }
  }

  async function createRuntime(
    input: ServiceInitialize
  ): Promise<{ runtime: ServiceRuntime; events: ServiceEvent[] }> {
    const events: ServiceEvent[] = []
    const runtime = await ServiceRuntime.create(input, (event) => events.push(event))
    runtimes.push(runtime)
    return { runtime, events }
  }

  async function listInboxSubjects(runtime: ServiceRuntime): Promise<string[]> {
    const page = (await runtime.invoke(IPC_CHANNELS.mailListThreads, [{ view: 'inbox' }])) as ThreadPage
    return page.rows.map((row) => row.subject ?? '')
  }

  it('serves the active account only, switches durably, and sums the badge', async () => {
    const input = makeInput()
    const { runtime, events } = await createRuntime(input)

    expect(runtime.ready().accountIds).toEqual(['primary@attn.test', 'second@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])

    // The badge covers every account, not the active one (F12/F18).
    const badge = events.filter((event) => event.kind === 'badge').at(-1)
    expect(badge && badge.kind === 'badge' ? badge.unreadCount : null).toBe(3)

    await runtime.internal('set-active-account', ['second@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Beta launch', 'Beta digest'])
    const syncState = events.filter((event) => event.kind === 'sync-state').at(-1)
    expect(syncState && syncState.kind === 'sync-state' ? syncState.payload.phase : null).toBe('idle')

    await expect(runtime.internal('set-active-account', ['nobody@attn.test'])).rejects.toThrow(
      'unknown account'
    )

    // The switch persists: a relaunch against the same store resumes on the
    // switched-to account, not the roster head.
    await runtime.stop()
    const second = await createRuntime(makeInput())
    expect(second.runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(second.runtime)).toEqual(['Beta launch', 'Beta digest'])
  })

  it('retires a removed seed session and falls back to the survivor', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    await runtime.internal('set-active-account', ['second@attn.test'])

    runtime.control({
      kind: 'accounts',
      accounts: {
        config: null,
        accounts: [],
        activeAccountId: null,
        seedAccountIds: ['primary@attn.test']
      }
    })
    expect(runtime.ready().accountIds).toEqual(['primary@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
  })
})
