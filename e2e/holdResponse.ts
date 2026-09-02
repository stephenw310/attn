import type { ElectronApplication } from '@playwright/test'
import { expect } from './electron'

/**
 * Hold one real IPC result after main has finished computing it, without a
 * timing-based sleep. The returned function releases the held response, so a
 * spec can interleave a competing action deterministically between the
 * handler's work and its delivery to the renderer.
 */
export async function holdNextResponse(
  app: ElectronApplication,
  channel: string
): Promise<() => Promise<void>> {
  await app.evaluate(({ ipcMain }, channel) => {
    type Handler = Parameters<typeof ipcMain.handle>[1]
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error(`Missing handler: ${channel}`)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      const result = await original(...args)
      await new Promise<void>((resolve) => {
        Object.assign(globalThis, { releaseHeldResponse: resolve })
      })
      return result
    })
  }, channel)
  return async () => {
    await app.evaluate(() => {
      const state = globalThis as unknown as { releaseHeldResponse: () => void }
      state.releaseHeldResponse()
    })
  }
}

/** Poll until the held handler has finished its work and parked the response. */
export async function expectResponseHeld(app: ElectronApplication): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(
        () => typeof (globalThis as unknown as { releaseHeldResponse?: () => void }).releaseHeldResponse
      )
    )
    .toBe('function')
}
