import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeAttachmentFilename, writeAttachment } from './attachments'

describe('attachment filenames', () => {
  it('removes path traversal and filesystem control characters', () => {
    expect(safeAttachmentFilename('../../quarter\\report\u0000.pdf')).toBe('....quarterreport.pdf')
    expect(safeAttachmentFilename('invoice:<draft>?.pdf')).toBe('invoice__draft__.pdf')
  })

  it('prefixes Windows device names', () => {
    expect(safeAttachmentFilename('CON.pdf')).toBe('_CON.pdf')
    expect(safeAttachmentFilename('nul')).toBe('_nul')
    expect(safeAttachmentFilename('COM1.txt')).toBe('_COM1.txt')
    expect(safeAttachmentFilename('LPT9')).toBe('_LPT9')
    expect(safeAttachmentFilename('company.txt')).toBe('company.txt')
  })

  it('rejects empty and dot-only names', () => {
    expect(safeAttachmentFilename(' /\\ ')).toBeNull()
    expect(safeAttachmentFilename('...')).toBeNull()
  })

  it('uses collision-safe names without overwriting an earlier download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attn-attachment-'))
    try {
      const first = await writeAttachment(dir, 'receipt.pdf', Buffer.from('first'))
      const second = await writeAttachment(dir, 'receipt.pdf', Buffer.from('second'))
      expect(basename(first)).toBe('receipt.pdf')
      expect(basename(second)).toBe('receipt (2).pdf')
      expect(readFileSync(first, 'utf8')).toBe('first')
      expect(readFileSync(second, 'utf8')).toBe('second')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
