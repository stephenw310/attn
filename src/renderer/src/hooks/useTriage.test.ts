// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { TriageResult } from '../../../shared/actions'
import type { SnoozedThreadRow, ThreadRow } from '../../../shared/mail'
import { useTriage } from './useTriage'

const thread: ThreadRow = {
  id: 'thread-1',
  fromDisplay: 'Sender',
  subject: 'Subject',
  snippet: 'Snippet',
  lastMsgAt: 1,
  unread: false,
  starred: false,
  hasAttachment: false,
  returned: false,
  hasDraft: false,
  labelIds: []
}

test('rolls back overlapping failed star and unread actions independently', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  const rejections: Array<(error: Error) => void> = []
  const triageIpc = vi.fn(
    () =>
      new Promise<TriageResult>((_resolve, reject) => {
        rejections.push(reject)
      })
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { triage: triageIpc } } as unknown as Window['attn']
  })

  const container = document.createElement('div')
  const root = createRoot(container)
  let runTriage: ReturnType<typeof useTriage> | undefined
  let visibleRows: ThreadRow[] = []
  let visibleSearchRows: ThreadRow[] = []
  function Harness(): null {
    const [rows, setRows] = useState<ThreadRow[] | null>([thread])
    const [searchRows, setSearchRows] = useState<ThreadRow[]>([thread])
    const [, setSnoozedRows] = useState<SnoozedThreadRow[] | null>(null)
    const [, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
    const [, setSelectedIndex] = useState(0)
    visibleRows = rows ?? []
    visibleSearchRows = searchRows
    runTriage = useTriage({
      selectedIds: new Set(),
      selectedIndex: 0,
      threads: rows ?? [],
      readerOpen: false,
      view: 'inbox',
      preserveSelectionOnRefreshRef: { current: true },
      deferRefreshUntilRef: { current: 0 },
      selectedThreadIdRef: { current: thread.id },
      selectedRowRef: { current: null },
      setRealThreads: setRows,
      setRealSnoozedThreads: setSnoozedRows,
      setMailboxRows: () => {},
      updateSearchRows: (updater) => setSearchRows(updater),
      clearSelection: () => {},
      showToast: () => {},
      setExitingThreadIds,
      setSelectedIndex
    })
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    act(() => runTriage?.({ kind: 'star', threadIds: [thread.id], on: true }))
    act(() => runTriage?.({ kind: 'markUnread', threadIds: [thread.id], on: true }))
    expect(visibleRows[0]).toMatchObject({ starred: true, unread: true })
    expect(visibleSearchRows[0]).toMatchObject({ starred: true, unread: true })

    await act(async () => {
      rejections[0]?.(new Error('star failed'))
      rejections[1]?.(new Error('unread failed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(visibleRows[0]).toMatchObject({ starred: false, unread: false })
    expect(visibleSearchRows[0]).toMatchObject({ starred: false, unread: false })
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})
