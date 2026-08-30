import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { ThreadPage } from '../../shared/mail'
import { storeActionError } from '../actions/execute'
import { openDatabase } from '../db'
import type { ServiceEvent, ServiceInitialize } from './protocol'
import { IndexingSlot, ServiceRuntime } from './runtime'

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

  it('acknowledges a roster update only once deferred sessions exist, and switches wait for them', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Remove the active account, then re-add it through the awaited operation
    // main uses: the answer must name a session that actually exists, so the
    // published AuthStatus can never point at a still-retiring account.
    runtime.control({
      kind: 'accounts',
      accounts: { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['second@attn.test'] }
    })
    const active = await runtime.internal('apply-accounts', [
      {
        config: null,
        accounts: [],
        activeAccountId: 'primary@attn.test',
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    ])
    expect(active).toBe('primary@attn.test')
    expect(runtime.ready().accountIds).toContain('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])

    // And a switch aimed at a still-pending session waits instead of failing.
    runtime.control({
      kind: 'accounts',
      accounts: { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['second@attn.test'] }
    })
    runtime.control({
      kind: 'accounts',
      accounts: {
        config: null,
        accounts: [],
        activeAccountId: null,
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    })
    expect(runtime.ready().accountIds).toEqual(['second@attn.test'])
    expect(await runtime.internal('set-active-account', ['primary@attn.test'])).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
  })

  it('resumes auth-paused actions for the account that reauthenticated, not the active one', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')

    // Auth-paused rows on both accounts, written the way the executor stores
    // them. Sign-in no longer activates the reconnected account, so the resume
    // must follow the flow's account id rather than the active pointer.
    const db = openDatabase(input.dbPath)
    const insert = db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state, attempts, last_error)
       VALUES (?, 'archive', ?, '{}', 'failed', 3, ?)`
    )
    const authError = storeActionError(new Error('invalid_grant'), 'auth')
    insert.run('primary@attn.test', 't-alpha', authError)
    insert.run('second@attn.test', 't-beta', authError)
    db.close()

    expect(await runtime.internal('resume-auth-failures', ['second@attn.test'])).toBe(1)
    const states = openDatabase(input.dbPath)
    const rows = states
      .prepare('SELECT account_id, state FROM action_queue ORDER BY account_id')
      .all() as Array<{ account_id: string; state: string }>
    states.close()
    expect(rows).toEqual([
      { account_id: 'primary@attn.test', state: 'failed' },
      { account_id: 'second@attn.test', state: 'pending' }
    ])

    // Without an explicit account the operation still serves the active one.
    expect(await runtime.internal('resume-auth-failures', [])).toBe(1)
  })

  it('defers re-creating a re-added account until its predecessor workers retire', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Remove and immediately re-add the same account: the removal's draft and
    // outbox workers are still quiescing, so a second session for the same
    // rows must not exist yet — two executor sets could double a
    // non-idempotent remote draft create.
    runtime.control({
      kind: 'accounts',
      accounts: { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['second@attn.test'] }
    })
    runtime.control({
      kind: 'accounts',
      accounts: {
        config: null,
        accounts: [],
        activeAccountId: 'primary@attn.test',
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    })
    expect(runtime.ready().accountIds).toEqual(['second@attn.test'])

    // Once the retirement settles, the successor session appears and the
    // requested active account takes effect.
    await expect
      .poll(() => runtime.ready().accountIds.includes('primary@attn.test'), { timeout: 2000 })
      .toBe(true)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
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

describe('IndexingSlot', () => {
  it('grants the slot to the account that is active at release time', async () => {
    let active = 'a'
    const slot = new IndexingSlot((accountId) => accountId === active)
    const releaseA = await slot.acquire('a')

    const grants: string[] = []
    const waiters = ['b', 'c'].map((accountId) =>
      slot.acquire(accountId).then((release) => {
        grants.push(accountId)
        release()
      })
    )

    // The user switches to c while it is already queued behind b. Priority is
    // decided at hand-over, so c must run its chain before b.
    active = 'c'
    releaseA()
    await Promise.all(waiters)
    expect(grants).toEqual(['c', 'b'])
  })

  it('falls back to arrival order when no waiter is active', async () => {
    const slot = new IndexingSlot(() => false)
    const releaseA = await slot.acquire('a')
    const grants: string[] = []
    const waiters = ['b', 'c'].map((accountId) =>
      slot.acquire(accountId).then((release) => {
        grants.push(accountId)
        release()
      })
    )
    releaseA()
    await Promise.all(waiters)
    expect(grants).toEqual(['b', 'c'])
  })
})
