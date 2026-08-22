import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { MainToServiceMessage, ServiceInitialize, ServiceReady } from './protocol'
import { type ServiceChild, ServiceSupervisor } from './supervisor'

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() }
}))

const READY: ServiceReady = {
  accountId: 'user@example.com',
  schemaVersion: 15,
  background: { launchAtLogin: true, loginItemRegistered: true }
}

function initialization(): ServiceInitialize {
  return {
    protocolVersion: 2,
    dbPath: '/tmp/attn-supervisor-test.db',
    userDataPath: '/tmp/attn-supervisor-test',
    downloadsPath: '/tmp',
    testMode: true,
    auth: null,
    focused: false
  }
}

class FakeChild extends EventEmitter implements ServiceChild {
  readonly messages: MainToServiceMessage[] = []
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  throwOnRequest = false
  killed = false

  postMessage(message: MainToServiceMessage): void {
    if (this.throwOnRequest && message.type === 'request') throw new Error('post failed')
    this.messages.push(structuredClone(message))
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  ready(): void {
    this.emit('message', { type: 'ready', payload: READY })
  }

  exit(code = 1): void {
    this.emit('exit', code)
  }
}

describe('ServiceSupervisor', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('replays controls sent during startup before releasing ready callers', async () => {
    const child = new FakeChild()
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), { fork: () => child })
    const started = supervisor.start()

    supervisor.control({ kind: 'focus', focused: true })
    supervisor.setAuth({
      config: { client_id: 'client', client_secret: 'secret' },
      tokens: { access_token: 'access', expires_at: 1, email: 'user@example.com' },
      generation: 1
    })
    expect(child.messages.map((message) => message.type)).toEqual(['initialize'])

    child.ready()
    await expect(started).resolves.toEqual(READY)
    expect(child.messages.slice(1)).toEqual([
      { type: 'control', payload: { kind: 'focus', focused: true } },
      {
        type: 'control',
        payload: {
          kind: 'auth',
          auth: {
            config: { client_id: 'client', client_secret: 'secret' },
            tokens: { access_token: 'access', expires_at: 1, email: 'user@example.com' },
            generation: 1
          }
        }
      }
    ])
  })

  it('rejects an invoke if posting the request fails', async () => {
    const child = new FakeChild()
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), { fork: () => child })
    const started = supervisor.start()
    child.ready()
    await started
    child.throwOnRequest = true

    await expect(supervisor.invoke(IPC_CHANNELS.mailListThreads)).rejects.toThrow('post failed')
  })

  it('finishes shutdown promptly if the child exits before acknowledging stop', async () => {
    const child = new FakeChild()
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), { fork: () => child })
    const started = supervisor.start()
    child.ready()
    await started

    const stopped = supervisor.stop()
    expect(child.messages.at(-1)).toEqual({ type: 'control', payload: { kind: 'stop' } })
    child.exit()

    await expect(stopped).resolves.toBeUndefined()
    expect(child.killed).toBe(false)
  })

  it('rejects initial startup after three failed utility processes', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    let nextChild = 0
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), {
      fork: () => children[nextChild++],
      restartDelayMs: 10
    })
    const started = supervisor.start()

    children[0].exit(1)
    await vi.advanceTimersByTimeAsync(10)
    children[1].exit(1)
    await vi.advanceTimersByTimeAsync(20)
    children[2].exit(1)

    await expect(started).rejects.toThrow('failed to start after 3 attempts')
    expect(nextChild).toBe(3)
  })

  it('does not release ready callers after shutdown starts', async () => {
    const child = new FakeChild()
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), { fork: () => child })
    const started = supervisor.start()

    const stopped = supervisor.stop()
    child.ready()
    child.exit(0)

    await expect(started).rejects.toThrow('stopping')
    await expect(stopped).resolves.toBeUndefined()
  })

  it('backs off and stops restarting after repeated post-ready crashes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    let nextChild = 0
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), {
      fork: () => children[nextChild++],
      restartDelayMs: 10,
      maxRestartDelayMs: 40,
      restartFailureWindowMs: 1_000,
      maxRestartFailures: 3
    })
    const events = vi.fn()
    supervisor.onEvent(events)
    const started = supervisor.start()
    children[0].ready()
    await started
    expect(supervisor.terminalState()).toBeNull()

    children[0].exit(1)
    const waitingInvoke = supervisor.invoke(IPC_CHANNELS.mailListThreads)
    await vi.advanceTimersByTimeAsync(10)
    expect(nextChild).toBe(2)
    children[1].exit(1)
    await vi.advanceTimersByTimeAsync(19)
    expect(nextChild).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(nextChild).toBe(3)
    children[2].exit(1)

    await expect(waitingInvoke).rejects.toThrow('3 crashes within 1000 ms')
    await expect(supervisor.invoke(IPC_CHANNELS.mailListThreads)).rejects.toThrow('3 crashes within 1000 ms')
    expect(events).toHaveBeenCalledWith({
      kind: 'sync-state',
      payload: {
        phase: 'error',
        message: 'Mail service stopped after repeated crashes. Restart Attn.'
      }
    })
    // The broadcast above only reaches windows that already exist. A window
    // opened afterwards seeds its banner from this instead.
    expect(supervisor.terminalState()).toEqual({
      phase: 'error',
      message: 'Mail service stopped after repeated crashes. Restart Attn.'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(nextChild).toBe(3)
  })

  it('counts crashes after successful restarts toward the rolling-window breaker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    let nextChild = 0
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), {
      fork: () => children[nextChild++],
      restartDelayMs: 10,
      restartFailureWindowMs: 1_000,
      maxRestartFailures: 3
    })
    const started = supervisor.start()
    children[0].ready()
    await started

    children[0].exit(1)
    await vi.advanceTimersByTimeAsync(10)
    children[1].ready()
    await expect(supervisor.start()).resolves.toEqual(READY)

    children[1].exit(1)
    await vi.advanceTimersByTimeAsync(20)
    children[2].ready()
    await expect(supervisor.start()).resolves.toEqual(READY)

    children[2].exit(1)
    await expect(supervisor.start()).rejects.toThrow('3 crashes within 1000 ms')
    expect(nextChild).toBe(3)
  })

  it('forwards piped utility output through the main logger', async () => {
    const child = new FakeChild()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supervisor = new ServiceSupervisor('/utility.js', initialization(), { fork: () => child })
    const started = supervisor.start()

    child.stdout.write('[utility] standard output\n')
    child.stderr.write('[utility] standard error\n')

    expect(log).toHaveBeenCalledWith('[utility] standard output')
    expect(error).toHaveBeenCalledWith('[utility] standard error')

    child.ready()
    await started
    const stopped = supervisor.stop()
    child.exit(0)
    await stopped
  })
})
