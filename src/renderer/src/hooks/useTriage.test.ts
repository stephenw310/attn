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
  snoozed: false,
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
      moveCacheRows: rows ?? [],
      readerOpen: false,
      view: 'inbox',
      activeSplitId: null,
      searchOpen: false,
      preserveSelectionOnRefreshRef: { current: true },
      deferRefreshUntilRef: { current: 0 },
      selectedThreadIdRef: { current: thread.id },
      selectedRowRef: { current: null },
      realThreads: rows,
      setRealThreads: setRows,
      realSnoozedThreads: null,
      setRealSnoozedThreads: setSnoozedRows,
      mailboxRows: {},
      setMailboxRows: () => {},
      updateSearchRows: (updater) => setSearchRows(updater),
      clearSelection: () => {},
      showToast: () => {},
      autoAdvance: 'next',
      closeReader: () => {},
      reopenReader: () => {},
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

test('updates inactive Move cache membership immediately and restores it on rejection', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  let rejectTriage: ((error: Error) => void) | undefined
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        triage: () =>
          new Promise<TriageResult>((_resolve, reject) => {
            rejectTriage = reject
          })
      }
    } as unknown as Window['attn']
  })

  const movedThread = {
    ...thread,
    labelIds: ['INBOX', 'source'],
    snoozed: true,
    returned: true
  }
  const snoozedThread = { ...movedThread, dueAt: 123 }
  const container = document.createElement('div')
  const root = createRoot(container)
  let runTriage: ReturnType<typeof useTriage> | undefined
  let visibleInbox: ThreadRow[] = []
  let visibleSnoozed: SnoozedThreadRow[] = []
  let visibleAllMail: ThreadRow[] = []
  let visibleDestination: ThreadRow[] = []
  function Harness(): null {
    const [inboxRows, setInboxRows] = useState<ThreadRow[] | null>([movedThread])
    const [snoozedRows, setSnoozedRows] = useState<SnoozedThreadRow[] | null>([snoozedThread])
    const [mailboxRows, setMailboxRows] = useState<Record<string, ThreadRow[] | undefined>>({
      allMail: [movedThread],
      'label:source': [movedThread],
      'label:destination': []
    })
    const [, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
    const [, setSelectedIndex] = useState(0)
    visibleInbox = inboxRows ?? []
    visibleSnoozed = snoozedRows ?? []
    visibleAllMail = mailboxRows.allMail ?? []
    visibleDestination = mailboxRows['label:destination'] ?? []
    runTriage = useTriage({
      selectedIds: new Set(),
      selectedIndex: 0,
      threads: mailboxRows.allMail ?? [],
      moveCacheRows: mailboxRows.allMail ?? [],
      readerOpen: false,
      view: 'allMail',
      activeSplitId: null,
      searchOpen: false,
      preserveSelectionOnRefreshRef: { current: true },
      deferRefreshUntilRef: { current: 0 },
      selectedThreadIdRef: { current: movedThread.id },
      selectedRowRef: { current: null },
      realThreads: inboxRows,
      setRealThreads: setInboxRows,
      realSnoozedThreads: snoozedRows,
      setRealSnoozedThreads: setSnoozedRows,
      mailboxRows,
      setMailboxRows,
      clearSelection: () => {},
      showToast: () => {},
      autoAdvance: 'next',
      closeReader: () => {},
      reopenReader: () => {},
      setExitingThreadIds,
      setSelectedIndex
    })
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    act(() =>
      runTriage?.({
        kind: 'move',
        threadIds: [movedThread.id],
        destination: { kind: 'label', labelId: 'destination' },
        sourceLabelId: null
      })
    )
    expect(visibleInbox).toEqual([])
    expect(visibleSnoozed).toEqual([])
    expect(visibleAllMail[0]).toMatchObject({
      labelIds: ['source', 'destination'],
      snoozed: false,
      returned: false
    })
    expect(visibleDestination.map((row) => row.id)).toEqual([movedThread.id])

    await act(async () => {
      rejectTriage?.(new Error('move failed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(visibleInbox).toEqual([movedThread])
    expect(visibleSnoozed).toEqual([snoozedThread])
    expect(visibleAllMail).toEqual([movedThread])
    expect(visibleDestination).toEqual([])
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})

test("a rejected write reopens the reader that 'list' auto-advance closed", async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  let rejectTriage: ((error: Error) => void) | undefined
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        triage: () =>
          new Promise<TriageResult>((_resolve, reject) => {
            rejectTriage = reject
          })
      }
    } as unknown as Window['attn']
  })
  const closeReader = vi.fn()
  const reopenReader = vi.fn()

  const container = document.createElement('div')
  const root = createRoot(container)
  let runTriage: ReturnType<typeof useTriage> | undefined
  function Harness(): null {
    const [rows, setRows] = useState<ThreadRow[] | null>([{ ...thread, labelIds: ['INBOX'] }])
    const [, setSnoozedRows] = useState<SnoozedThreadRow[] | null>(null)
    const [, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
    const [, setSelectedIndex] = useState(0)
    runTriage = useTriage({
      selectedIds: new Set(),
      selectedIndex: 0,
      threads: rows ?? [],
      moveCacheRows: rows ?? [],
      readerOpen: true,
      view: 'inbox',
      activeSplitId: null,
      searchOpen: false,
      preserveSelectionOnRefreshRef: { current: true },
      deferRefreshUntilRef: { current: 0 },
      selectedThreadIdRef: { current: thread.id },
      selectedRowRef: { current: null },
      realThreads: rows,
      setRealThreads: setRows,
      realSnoozedThreads: null,
      setRealSnoozedThreads: setSnoozedRows,
      mailboxRows: {},
      setMailboxRows: () => {},
      clearSelection: () => {},
      showToast: () => {},
      autoAdvance: 'list',
      closeReader,
      reopenReader,
      setExitingThreadIds,
      setSelectedIndex
    })
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    act(() => runTriage?.({ kind: 'archive', threadIds: [thread.id] }))
    expect(closeReader).toHaveBeenCalledTimes(1)
    expect(reopenReader).not.toHaveBeenCalled()

    await act(async () => {
      rejectTriage?.(new Error('utility gone'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(reopenReader).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})
