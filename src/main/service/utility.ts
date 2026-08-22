import { errorMessage } from '../../shared/error'
import { isMainToServiceMessage, SERVICE_PROTOCOL_VERSION, type ServiceToMainMessage } from './protocol'
import { ServiceRuntime } from './runtime'

const servicePort = process.parentPort
if (!servicePort) throw new Error('Attn service utility requires an Electron parent port')

let runtime: ServiceRuntime | null = null
let initializing: Promise<ServiceRuntime> | null = null
let stopping = false

function send(message: ServiceToMainMessage): void {
  servicePort.postMessage(message)
}

function sendError(id: number, error: unknown): void {
  send({
    type: 'response-error',
    id,
    message: errorMessage(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  })
}

servicePort.on('message', (event) => {
  const message = event.data
  if (!isMainToServiceMessage(message)) return
  if (message.type === 'initialize') {
    if (runtime || initializing) return
    if (message.payload.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
      throw new Error(
        `service protocol mismatch: main ${message.payload.protocolVersion}, utility ${SERVICE_PROTOCOL_VERSION}`
      )
    }
    initializing = ServiceRuntime.create(message.payload, (payload) => send({ type: 'event', payload }))
    void initializing
      .then((created) => {
        initializing = null
        if (stopping) {
          return created.stop().then(() => send({ type: 'stopped' }))
        }
        runtime = created
        send({ type: 'ready', payload: created.ready() })
      })
      .catch((error) => {
        console.error(`[utility] initialization failed: ${errorMessage(error)}`)
        process.exit(1)
      })
    return
  }
  if (message.type === 'control' && message.payload.kind === 'stop') {
    if (stopping) return
    stopping = true
    const active = runtime
    if (!active) return
    void active
      .stop()
      .then(() => send({ type: 'stopped' }))
      .catch((error) => {
        console.error(`[utility] shutdown failed: ${errorMessage(error)}`)
        send({ type: 'stopped' })
      })
    return
  }
  const active = runtime
  if (!active) return
  if (message.type === 'request') {
    void active
      .invoke(message.channel, message.args)
      .then((result) => send({ type: 'response', id: message.id, result }))
      .catch((error) => sendError(message.id, error))
    return
  }
  if (message.type === 'internal-request') {
    void active
      .internal(message.operation, message.args)
      .then((result) => send({ type: 'response', id: message.id, result }))
      .catch((error) => sendError(message.id, error))
    return
  }
  active.control(message.payload)
})
