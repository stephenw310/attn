import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** Remove one draft's owned attachment directory without escaping userData. */
export function cleanOutboxSpool(userDataPath: string, id: string): void {
  const root = resolve(userDataPath, 'outbox')
  const directory = resolve(root, id)
  const relativePath = relative(root, directory)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return
  void rm(directory, { recursive: true, force: true }).catch(() => {})
}
