import { app, BrowserWindow, Notification, nativeImage } from 'electron'
import badgeIcon from '../../resources/tray.png?asset'
import type { Db } from './db'
import { countInboxUnread } from './db/queries'
import type { NewMail } from './sync/poller'
import { historyEvents } from './sync/poller'

const APP_SETTINGS_ACCOUNT_ID = '__app__'
const PAUSED_UNTIL_KEY = 'notificationsPausedUntil'

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
  const row = db
    .prepare('SELECT value FROM settings WHERE account_id = ? AND key = ?')
    .get(APP_SETTINGS_ACCOUNT_ID, PAUSED_UNTIL_KEY) as { value: string } | undefined
  if (!row) return null
  const value = Number(row.value)
  return Number.isFinite(value) ? value : null
}

export function setNotificationPausedUntil(db: Db, pausedUntil: number | null): void {
  if (pausedUntil === null) {
    db.prepare('DELETE FROM settings WHERE account_id = ? AND key = ?').run(
      APP_SETTINGS_ACCOUNT_ID,
      PAUSED_UNTIL_KEY
    )
    return
  }
  db.prepare('INSERT OR REPLACE INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(
    APP_SETTINGS_ACCOUNT_ID,
    PAUSED_UNTIL_KEY,
    String(pausedUntil)
  )
}

export function tomorrowStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

function candidatesFor(db: Db, accountId: string, newMail: readonly NewMail[]): NotificationCandidate[] {
  const candidates: NotificationCandidate[] = []
  for (const mail of newMail) {
    const row = db
      .prepare(
        `SELECT m.from_name, m.from_email, m.snippet, t.subject
         FROM messages m
         JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
         WHERE m.account_id = ? AND m.id = ? AND m.thread_id = ?
           AND EXISTS (SELECT 1 FROM thread_labels tl
                       WHERE tl.account_id = t.account_id AND tl.thread_id = t.id
                         AND tl.label_id = 'INBOX')`
      )
      .get(accountId, mail.messageId, mail.threadId) as
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

function focusThread(threadId: string, showMainWindow: () => BrowserWindow | null): void {
  const win = showMainWindow()
  if (!win) return
  const send = (): void => win.webContents.send('mail:focusThread', { threadId })
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send)
  else send()
}

export class MailNotifier {
  private readonly onNewMail = (newMail: NewMail[]): void => this.notify(newMail)

  constructor(
    private readonly db: Db,
    private readonly currentAccountId: () => string | null,
    private readonly showMainWindow: () => BrowserWindow | null
  ) {}

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
    const accountId = this.currentAccountId()
    const unreadCount = accountId ? countInboxUnread(this.db, accountId) : 0
    if (process.platform === 'darwin') {
      app.setBadgeCount(unreadCount)
    } else if (process.platform === 'win32') {
      const icon = unreadCount > 0 ? nativeImage.createFromPath(badgeIcon) : null
      const description = unreadCount > 0 ? `${unreadCount} unread conversations` : ''
      for (const win of BrowserWindow.getAllWindows()) win.setOverlayIcon(icon, description)
    }
  }

  private notify(newMail: readonly NewMail[]): void {
    const accountId = this.currentAccountId()
    if (!accountId || !Notification.isSupported()) return
    const planned = planNotifications(candidatesFor(this.db, accountId, newMail), {
      focused: BrowserWindow.getAllWindows().some((win) => win.isFocused()),
      pausedUntil: notificationPausedUntil(this.db)
    })
    for (const item of planned) {
      const notification = new Notification({ title: item.title, body: item.body })
      const threadId = item.threadId
      notification.on('click', () => {
        if (threadId) focusThread(threadId, this.showMainWindow)
        else this.showMainWindow()
      })
      notification.show()
    }
  }
}
