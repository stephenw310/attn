import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Newest file under `dir`, recursively. A directory's own mtime ignores writes inside its files. */
export function newestMtime(dir) {
  let newest = { path: dir, mtime: statSync(dir).mtimeMs }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const candidate = entry.isDirectory() ? newestMtime(path) : { path, mtime: statSync(path).mtimeMs }
    if (candidate.mtime > newest.mtime) newest = candidate
  }
  return newest
}
