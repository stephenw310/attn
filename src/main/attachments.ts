import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

export function safeAttachmentFilename(untrusted: string): string | null {
  const printable = Array.from(untrusted.normalize('NFKC'))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && !(code >= 127 && code <= 159)
    })
    .join('')
  const cleaned = printable
    .replaceAll('\\', '')
    .replaceAll('/', '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!cleaned || /^\.+$/.test(cleaned)) return null
  return cleaned
}

export async function writeAttachment(
  downloadsDir: string,
  untrustedFilename: string,
  data: Uint8Array
): Promise<string> {
  const filename = safeAttachmentFilename(untrustedFilename)
  if (!filename) throw new Error('invalid attachment filename')

  const extension = extname(filename)
  const stem = extension ? filename.slice(0, -extension.length) : filename
  for (let attempt = 1; attempt <= 10_000; attempt++) {
    const candidate = attempt === 1 ? filename : `${stem} (${attempt})${extension}`
    const path = join(downloadsDir, candidate)
    try {
      await writeFile(path, data, { flag: 'wx' })
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not choose a free attachment filename')
}
