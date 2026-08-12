import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { pruneMissingMessages } from './persist'

describe('thread snapshot persistence', () => {
  it('prunes messages absent from the latest surviving thread snapshot', () => {
    const run = vi.fn()
    let sql = ''
    const db = {
      prepare: (statement: string) => {
        sql = statement
        return { run }
      }
    } as unknown as Db

    pruneMissingMessages(db, 'account', 'thread', ['m2', 'm3'])

    expect(sql).toContain('id NOT IN (?, ?)')
    expect(run).toHaveBeenCalledWith('account', 'thread', 'm2', 'm3')
  })
})
