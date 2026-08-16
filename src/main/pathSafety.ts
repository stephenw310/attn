import { isAbsolute, relative, resolve, sep } from 'node:path'

/** True only when `candidate` is a strict descendant of `root`. */
export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}
