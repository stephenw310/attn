import { app, BrowserWindow, type NativeImage, Notification, nativeImage } from 'electron'
import badgeIcon from '../../resources/tray.png?asset'
import type { Db } from './db'
import { countInboxUnread } from './db/queries'
import { deleteSetting, readSetting, writeSetting } from './settings'
import type { NewMail } from './sync/poller'
import { historyEvents } from './sync/poller'

const PAUSED_UNTIL_KEY = 'notificationsPausedUntil'
let windowsBadgeIcon: NativeImage | null = null

export interface NotificationCandidate extends NewMail {
  sender: string
  subject: string
  snippet: string
}

export interface PlannedNotification {
  threadId?: string
  title: string
  body: string
}

export interface NotificationContext {
  focused: boolean
  pausedUntil?: number | null
  now?: number
}

export interface BadgeEffects {
  setMacBadge: (count: number) => void
  setWindowsOverlay: (show: boolean, description: string) => void
}

export function isolateNotificationFailure(operation: () => void, report: (message: string) => void): void {
  try {
    operation()
  } catch (error) {
    report(error instanceof Error ? error.message : String(error))
  }
}

export function applyUnreadBadge(
  platform: NodeJS.Platform,
  unreadCount: number,
  effects: BadgeEffects
): void {
  if (platform === 'darwin') effects.setMacBadge(unreadCount)
  else if (platform === 'win32') {
    effects.setWindowsOverlay(unreadCount > 0, unreadCount > 0 ? `${unreadCount} unread conversations` : '')
  }
}

/** Keep batching policy independent from Electron so it can be exhaustively unit tested. */
export function planNotifications(
  newMail: readonly NotificationCandidate[],
  { focused, pausedUntil, now = Date.now() }: NotificationContext
): PlannedNotification[] {
  if (focused || (pausedUntil !== null && pausedUntil !== undefined && pausedUntil > now)) return []

  const byThread = new Map<string, NotificationCandidate>()
  for (const mail of newMail) byThread.set(mail.threadId, mail)
  const conversations = [...byThread.values()]
  if (conversations.length > 3) {
    return [{ title: 'Attn', body: `${conversations.length} new conversations` }]
  }
  return conversations.map((mail) => ({
    threadId: mail.threadId,
    title: `${mail.sender || 'New message'} · ${mail.subject || '(no subject)'}`,
    body: mail.snippet
  }))
}

export function notificationPausedUntil(db: Db): number | null {
  const stored = readSetting(db, PAUSED_UNTIL_KEY)
  if (stored === undefined) return null
  const value = Number(stored)
  return Number.isFinite(value) ? value : null
}

export function setNotificationPausedUntil(db: Db, pausedUntil: number | null): void {
  if (pausedUntil === null) {
    deleteSetting(db, PAUSED_UNTIL_KEY)
    return
  }
  writeSetting(db, PAUSED_UNTIL_KEY, String(pausedUntil))
}

export function tomorrowStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

export function oneHourFrom(now = Date.now()): number {
  return now + 60 * 60 * 1000
}

function candidatesFor(db: Db, accountId: string, newMail: readonly NewMail[]): NotificationCandidate[] {
  const distinct = new Map<string, NewMail>()
  for (const mail of newMail) distinct.set(mail.threadId, mail)
  if (distinct.size === 0) return []
  const placeholders = [...distinct].map(() => '?').join(', ')
  const inboxRows = db
    .prepare(
      `SELECT thread_id FROM thread_labels
       WHERE account_id = ? AND label_id = 'INBOX' AND thread_id IN (${placeholders})`
    )
    .all(accountId, ...distinct.keys()) as { thread_id: string }[]
  const inboxMail = inboxRows.flatMap((row) => {
    const mail = distinct.get(row.thread_id)
    return mail ? [mail] : []
  })
  if (inboxMail.length > 3) {
    return inboxMail.map((mail) => ({ ...mail, sender: '', subject: '', snippet: '' }))
  }

  const candidates: NotificationCandidate[] = []
  const statement = db.prepare(
    `SELECT m.from_name, m.from_email, m.snippet, t.subject
         FROM messages m
         JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
         WHERE m.account_id = ? AND m.id = ? AND m.thread_id = ?`
  )
  for (const mail of inboxMail) {
    const row = statement.get(accountId, mail.messageId, mail.threadId) as
      | {
          from_name: string | null
          from_email: string | null
          snippet: string | null
          subject: string | null
        }
      | undefined
    if (!row) continue
    candidates.push({
      ...mail,
      sender: row.from_name || row.from_email || '',
      subject: row.subject || '(no subject)',
      snippet: row.snippet || ''
    })
  }
  return candidates
}

function getWindowsBadgeIcon(): NativeImage {
  windowsBadgeIcon ??= nativeImage.createFromPath(badgeIcon)
  return windowsBadgeIcon
}

export class MailNotifier {
  private readonly onNewMail = (newMail: NewMail[]): void => {
    isolateNotificationFailure(
      () => this.notify(newMail),
      (message) => console.error(`[notify] failed: ${message}`)
    )
  }
  private accountId: string | null

  constructor(
    private readonly db: Db,
    accountId: string | null,
    private readonly showMainWindow: () => BrowserWindow | null,
    private readonly focusThread: (threadId: string) => void
  ) {
    this.accountId = accountId
  }

  start(): void {
    historyEvents.on('newMail', this.onNewMail)
    this.updateBadge()
  }

  stop(): void {
    historyEvents.off('newMail', this.onNewMail)
    if (process.platform === 'darwin') app.setBadgeCount(0)
    if (process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) win.setOverlayIcon(null, '')
    }
  }

  updateBadge(): void {
    try {
      const unreadCount = this.accountId ? countInboxUnread(this.db, this.accountId) : 0
      applyUnreadBadge(process.platform, unreadCount, {
        setMacBadge: (count) => app.setBadgeCount(count),
        setWindowsOverlay: (show, description) => {
          const icon = show ? getWindowsBadgeIcon() : null
          for (const win of BrowserWindow.getAllWindows()) win.setOverlayIcon(icon, description)
        }
      })
    } catch (error) {
      console.error(`[badge] failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  setAccountId(accountId: string | null): void {
    this.accountId = accountId
    this.updateBadge()
  }

  private notify(newMail: readonly NewMail[]): void {
    const accountId = this.accountId
    if (!accountId || !Notification.isSupported()) return
    const planned = planNotifications(candidatesFor(this.db, accountId, newMail), {
      focused: BrowserWindow.getAllWindows().some((win) => win.isFocused()),
      pausedUntil: notificationPausedUntil(this.db)
    })
    for (const item of planned) {
      const notification = new Notification({ title: item.title, body: item.body })
      const threadId = item.threadId
      notification.on('click', () => {
        if (threadId) this.focusThread(threadId)
        else this.showMainWindow()
      })
      notification.show()
    }
  }
}
