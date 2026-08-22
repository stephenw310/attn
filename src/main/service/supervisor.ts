import type { Readable } from 'node:stream'
import { utilityProcess } from 'electron'
import type { InvokeChannel, InvokeChannels } from '../../shared/ipc'
import type { TokenSet } from '../auth/googleAuth'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import type {
  MainToServiceMessage,
  ServiceAuth,
  ServiceControl,
  ServiceEvent,
  ServiceInitialize,
  ServiceOperation,
  ServiceReady,
  ServiceToMainMessage
} from './protocol'

const RESTART_DELAY_MS = 100
const MAX_RESTART_DELAY_MS = 5_000
const RESTART_FAILURE_WINDOW_MS = 60_000
const MAX_RESTART_FAILURES = 5
const STOP_TIMEOUT_MS = 10_000
const MAX_INITIAL_START_FAILURES = 3

export interface ServiceChild {
  postMessage(message: MainToServiceMessage): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  stdout?: Readable | null
  stderr?: Readable | null
}

export type ServiceFork = () => ServiceChild

function forwardOutput(stream: Readable | null | undefined, level: 'log' | 'error'): void {
  if (!stream) return
  let buffered = ''
  const flush = (includeRemainder: boolean): void => {
    const lines = buffered.split(/\r?\n/)
    buffered = includeRemainder ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (line) console[level](line)
    }
  }
  stream.on('data', (chunk) => {
    buffered += String(chunk)
    flush(false)
  })
  stream.on('end', () => flush(true))
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export interface ServiceSupervisorOptions {
  fork?: ServiceFork
  restartDelayMs?: number
  maxRestartDelayMs?: number
  restartFailureWindowMs?: number
  maxRestartFailures?: number
  time?: SchedulerTime
}

export class ServiceSupervisor {
  private child: ServiceChild | null = null
  private readyState: ServiceReady | null = null
  private readyWaiters: Array<{ resolve: (ready: ServiceReady) => void; reject: (error: Error) => void }> = []
  private pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private stopping = false
  private hasEverBeenReady = false
  private initialStartFailures = 0
  private restartFailures: number[] = []
  private stoppedAck: (() => void) | null = null
  private queuedControls: ServiceControl[] = []
  private eventSink: (event: ServiceEvent) => void = () => {}
  private readonly fork: ServiceFork
  private readonly restartDelayMs: number
  private readonly maxRestartDelayMs: number
  private readonly restartFailureWindowMs: number
  private readonly maxRestartFailures: number
  private readonly time: SchedulerTime

  constructor(
    utilityPath: string,
    private readonly initialize: ServiceInitialize,
    options: ServiceSupervisorOptions = {}
  ) {
    this.fork =
      options.fork ??
      (() =>
        utilityProcess.fork(utilityPath, [], {
          serviceName: 'Attn Service',
          stdio: ['ignore', 'pipe', 'pipe']
        }) as ServiceChild)
    this.restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS
    this.maxRestartDelayMs = options.maxRestartDelayMs ?? MAX_RESTART_DELAY_MS
    this.restartFailureWindowMs = options.restartFailureWindowMs ?? RESTART_FAILURE_WINDOW_MS
    this.maxRestartFailures = options.maxRestartFailures ?? MAX_RESTART_FAILURES
    this.time = options.time ?? systemTime
  }

  onEvent(sink: (event: ServiceEvent) => void): void {
    this.eventSink = sink
  }

  start(): Promise<ServiceReady> {
    if (this.stopping) return Promise.reject(new Error('Attn service is stopping'))
    if (!this.child) this.spawn()
    return this.waitUntilReady()
  }

  async invoke<K extends InvokeChannel>(
    channel: K,
    ...args: unknown[]
  ): Promise<InvokeChannels[K]['result']> {
    await this.waitUntilReady()
    return (await this.request({ type: 'request', channel, args })) as InvokeChannels[K]['result']
  }

  async internal(operation: ServiceOperation, ...args: unknown[]): Promise<unknown> {
    await this.waitUntilReady()
    return this.request({ type: 'internal-request', operation, args })
  }

  control(payload: ServiceControl): void {
    if (payload.kind === 'auth') this.initialize.auth = payload.auth
    if (payload.kind === 'focus') this.initialize.focused = payload.focused
    if (!this.child || !this.readyState) {
      this.queueControl(payload)
      return
    }
    try {
      this.child.postMessage({ type: 'control', payload })
    } catch {
      this.queueControl(payload)
    }
  }

  setAuth(auth: ServiceAuth | null): void {
    this.control({ kind: 'auth', auth })
  }

  cacheTokens(tokens: TokenSet): void {
    if (this.initialize.auth) this.initialize.auth = { ...this.initialize.auth, tokens }
  }

  signOut(): void {
    this.initialize.auth = null
    this.control({ kind: 'sign-out' })
  }

  async crashForTest(): Promise<ServiceReady> {
    if (!this.initialize.testMode) throw new Error('utility crash seam is disabled')
    const child = this.child
    if (!child) throw new Error('utility is not running')
    child.kill()
    return this.waitUntilReady(true)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    const child = this.child
    this.queuedControls = []
    if (!child) {
      this.rejectReadyWaiters(new Error('Attn service stopped'))
      return
    }
    const stopped = new Promise<void>((resolve) => {
      this.stoppedAck = resolve
    })
    try {
      child.postMessage({ type: 'control', payload: { kind: 'stop' } })
    } catch {
      if (this.child === child) {
        child.kill()
        this.child = null
      }
      const error = new Error('Attn service stopped')
      this.rejectPending(error)
      this.rejectReadyWaiters(error)
      return
    }
    let timeout: TimerHandle | null = null
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timeout = this.time.timers.setTimeout(resolve, STOP_TIMEOUT_MS)
      })
    ])
    if (timeout) this.time.timers.clearTimeout(timeout)
    if (this.child === child) {
      child.kill()
      this.child = null
    }
    const error = new Error('Attn service stopped')
    this.rejectPending(error)
    this.rejectReadyWaiters(error)
  }

  private spawn(): void {
    const child = this.fork()
    this.child = child
    this.readyState = null
    forwardOutput(child.stdout, 'log')
    forwardOutput(child.stderr, 'error')
    child.on('message', (message) => this.receive(child, message))
    child.on('exit', (code) => this.exited(child, code))
    child.postMessage({ type: 'initialize', payload: this.initialize })
  }

  private receive(child: ServiceChild, value: unknown): void {
    if (child !== this.child || !value || typeof value !== 'object') return
    const message = value as ServiceToMainMessage
    if (message.type === 'ready') {
      if (this.stopping) {
        this.rejectReadyWaiters(new Error('Attn service is stopping'))
        return
      }
      this.readyState = message.payload
      this.hasEverBeenReady = true
      this.initialStartFailures = 0
      const controls = this.queuedControls.splice(0)
      for (let index = 0; index < controls.length; index++) {
        try {
          child.postMessage({ type: 'control', payload: controls[index] })
        } catch {
          this.queuedControls.unshift(...controls.slice(index))
          break
        }
      }
      const waiters = this.readyWaiters.splice(0)
      for (const waiter of waiters) waiter.resolve(message.payload)
      return
    }
    if (message.type === 'response' || message.type === 'response-error') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.type === 'response') pending.resolve(message.result)
      else pending.reject(Object.assign(new Error(message.message), { stack: message.stack }))
      return
    }
    if (message.type === 'event') {
      try {
        this.eventSink(message.payload)
      } catch (error) {
        console.error(
          `[utility] event handler failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return
    }
    if (message.type === 'stopped') this.stoppedAck?.()
  }

  private exited(child: ServiceChild, code: number): void {
    if (child !== this.child) return
    this.child = null
    this.readyState = null
    this.rejectPending(new Error(`Attn service exited (${code})`))
    if (this.stopping) {
      this.stoppedAck?.()
      return
    }
    if (!this.hasEverBeenReady) {
      this.initialStartFailures++
      if (this.initialStartFailures >= MAX_INITIAL_START_FAILURES) {
        const error = new Error(
          `Attn service failed to start after ${this.initialStartFailures} attempts (last exit ${code})`
        )
        this.stopping = true
        this.rejectReadyWaiters(error)
        console.error(`[utility] ${error.message}`)
        return
      }
    } else {
      const now = this.time.now()
      this.restartFailures = this.restartFailures.filter(
        (failedAt) => now - failedAt <= this.restartFailureWindowMs
      )
      this.restartFailures.push(now)
      if (this.restartFailures.length >= this.maxRestartFailures) {
        const error = new Error(
          `Attn service stopped after ${this.restartFailures.length} crashes within ${this.restartFailureWindowMs} ms (last exit ${code})`
        )
        this.stopping = true
        this.rejectReadyWaiters(error)
        console.error(`[utility] ${error.message}`)
        return
      }
    }
    const failures = this.hasEverBeenReady ? this.restartFailures.length : this.initialStartFailures
    const restartDelay = Math.min(
      this.restartDelayMs * 2 ** Math.max(0, failures - 1),
      this.maxRestartDelayMs
    )
    console.error(`[utility] exited (${code}); restarting in ${restartDelay} ms`)
    this.time.timers.setTimeout(() => {
      if (!this.stopping && !this.child) this.spawn()
    }, restartDelay)
  }

  private waitUntilReady(requireNext = false): Promise<ServiceReady> {
    if (this.stopping) return Promise.reject(new Error('Attn service is stopping'))
    if (!requireNext && this.readyState) return Promise.resolve(this.readyState)
    return new Promise<ServiceReady>((resolve, reject) => this.readyWaiters.push({ resolve, reject }))
  }

  private request(
    message:
      | Omit<Extract<MainToServiceMessage, { type: 'request' }>, 'id'>
      | Omit<Extract<MainToServiceMessage, { type: 'internal-request' }>, 'id'>
  ): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Attn service is unavailable'))
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        child.postMessage({ ...message, id } as MainToServiceMessage)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = this.readyWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  private queueControl(payload: ServiceControl): void {
    if (payload.kind === 'auth' || payload.kind === 'sign-out') {
      this.queuedControls = this.queuedControls.filter(
        (queued) => queued.kind !== 'auth' && queued.kind !== 'sign-out'
      )
    } else if (payload.kind === 'focus') {
      this.queuedControls = this.queuedControls.filter((queued) => queued.kind !== 'focus')
    } else if (this.queuedControls.some((queued) => queued.kind === payload.kind)) {
      return
    }
    this.queuedControls.push(payload)
  }
}
