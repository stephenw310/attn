import { describe, expect, it, vi } from 'vitest'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { deleteDraftCheckpoint, saveDraftCheckpoint } from './mirror'

describe('draft mirror recovery', () => {
  it('clears a Gmail-deleted id and recreates the draft', async () => {
    const saveDraft = vi
      .fn()
      .mockRejectedValueOnce(new GmailApiError(404, 'gone'))
      .mockResolvedValueOnce('replacement-id')
    const onRemoteMissing = vi.fn(() => true)

    await expect(saveDraftCheckpoint({ saveDraft }, 'deleted-id', 'raw', onRemoteMissing)).resolves.toBe(
      'replacement-id'
    )
    expect(onRemoteMissing).toHaveBeenCalledOnce()
    expect(saveDraft).toHaveBeenNthCalledWith(1, { id: 'deleted-id', raw: 'raw' })
    expect(saveDraft).toHaveBeenNthCalledWith(2, { id: null, raw: 'raw' })
  })

  it('does not recreate a remotely deleted draft after local discard wins the race', async () => {
    const saveDraft = vi.fn().mockRejectedValue(new GmailApiError(404, 'gone'))
    await expect(saveDraftCheckpoint({ saveDraft }, 'deleted-id', 'raw', () => false)).resolves.toBeNull()
    expect(saveDraft).toHaveBeenCalledOnce()
  })

  it('treats an already-deleted Gmail draft as a successful discard', async () => {
    const provider = {
      deleteDraft: vi.fn().mockRejectedValue(new GmailApiError(404, 'gone'))
    } satisfies Pick<MailActionProvider, 'deleteDraft'>
    await expect(deleteDraftCheckpoint(provider, 'deleted-id')).resolves.toBe(true)
  })
})
