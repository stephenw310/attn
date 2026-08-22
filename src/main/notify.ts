import { app, BrowserWindow, type NativeImage, Notification, nativeImage } from 'electron'
import badgeIcon from '../../resources/tray.png?asset'
import { errorMessage } from '../shared/error'
import { NOTIFICATION_SUMMARY_THRESHOLD } from '../shared/notifications'
import type { NotificationCandidate } from './service/notificationQueries'

let windowsBadgeIcon: NativeImage | null = null

/**
 * Above this many new conversations a poll cycle collapses to one summary.
 * `candidatesFor` skips hydration past this point, so both sides must agree:
 * a threshold raised here alone would plan detail notifications from rows that
 * were never hydrated, titling them "New message · (no subject)".
 */
export const SUMMARY_THRESHOLD = NOTIFICATION_SUMMARY_THRESHOLD

/** A focus target is only worth honouring briefly — see `takePendingFocus`. */
export const PENDING_FOCUS_TTL_MS = 60_000

/** How many shown notifications stay reachable for a click. See `BoundedRetainer`. */
export const NOTIFICATION_RETENTION = 50

/**
 * Keeps values alive, newest-first, so the garbage collector cannot reclaim them.
 *
 * Electron `Notification` objects are eligible for collection as soon as the
 * function that created them returns, and a collected notification never fires
 * `click` — the OS keeps drawing the banner while the object that would react to
 * it is gone, so clicking only activates the app. Retaining the reference is what
 * makes click-to-open work at all; this was the M1 exit smoke failure (2026-08-13).
 *
 * Deliberately *not* released on `close`: Electron does not guarantee that event,
 * and a macOS banner that slides into Notification Center stays clickable, so
 * dropping the reference there would reintroduce the bug. The cap bounds growth
 * instead, evicting the oldest — the ones least likely to still be clicked.
 */
export class BoundedRetainer<T> {
  private readonly held: T[] = []

  constructor(private readonly cap: number) {}

  retain(value: T): void {
    this.held.push(value)
    if (this.held.length > this.cap) this.held.splice(0, this.held.length - this.cap)
  }

  release(value: T): void {
    const index = this.held.indexOf(value)
    if (index >= 0) this.held.splice(index, 1)
  }

  clear(): void {
    this.held.length = 0
  }

  get size(): number {
    return this.held.length
  }
}

export interface PendingFocus {
  threadId: string
  at: number
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
    report(errorMessage(error))
  }
}

export function applyUnreadBadge(
  platform: NodeJS.Platform,
  unreadCount: number,
  effects: BadgeEffects
): void {
  if (platform === 'darwin') effects.setMacBadge(unreadCount)
  else applyUnreadBadgeToWindow(platform, unreadCount, effects.setWindowsOverlay)
}

export function applyUnreadBadgeToWindow(
  platform: NodeJS.Platform,
  unreadCount: number,
  setWindowsOverlay: BadgeEffects['setWindowsOverlay']
): void {
  if (platform !== 'win32') return
  setWindowsOverlay(unreadCount > 0, unreadCount > 0 ? `${unreadCount} unread conversations` : '')
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
  if (conversations.length > SUMMARY_THRESHOLD) {
    return [{ title: 'Attn', body: `${conversations.length} new conversations` }]
  }
  return conversations.map((mail) => ({
    threadId: mail.threadId,
    title: `${mail.sender || 'New message'} · ${mail.subject || '(no subject)'}`,
    body: mail.snippet
  }))
}

export function tomorrowStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

export function oneHourFrom(now = Date.now()): number {
  return now + 60 * 60 * 1000
}

/**
 * Consume a focus target requested by a notification click. A renderer that
 * never picks one up (its window was closed again before it mounted, or the
 * account signed out) must not redirect an unrelated window opened much later,
 * so a stale target is dropped rather than honoured.
 */
export function takePendingFocus(pending: PendingFocus | null, now = Date.now()): string | null {
  if (!pending) return null
  return now - pending.at > PENDING_FOCUS_TTL_MS ? null : pending.threadId
}

/**
 * A banner outlives the session that created it: it can sit in Notification
 * Center across a sign-out and sign-in. Clicking it must not aim a previous
 * account's thread id at the current one — the renderer would leave whatever the
 * user is reading, reset the selection, and only then discover the thread is not
 * there. `pendingFocus` is already cleared on account changes for this reason;
 * a retained click handler would otherwise route straight around that guard.
 */
export function notificationTarget(
  threadId: string | undefined,
  notifiedAccount: string | null,
  currentAccount: string | null
): string | null {
  if (!threadId) return null
  return notifiedAccount !== null && notifiedAccount === currentAccount ? threadId : null
}

function getWindowsBadgeIcon(): NativeImage {
  windowsBadgeIcon ??= nativeImage.createFromPath(badgeIcon)
  return windowsBadgeIcon
}

export class MailNotifier {
  private accountId: string | null
  private unreadCount = 0
  private readonly shown = new BoundedRetainer<Notification>(NOTIFICATION_RETENTION)

  constructor(
    accountId: string | null,
    private readonly showMainWindow: () => BrowserWindow | null,
    private readonly focusThread: (threadId: string) => void
  ) {
    this.accountId = accountId
  }

  start(): void {
    this.updateBadge(0)
  }

  stop(): void {
    this.shown.clear()
    if (process.platform === 'darwin') app.setBadgeCount(0)
    if (process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) win.setOverlayIcon(null, '')
    }
  }

  updateBadge(unreadCount: number): void {
    this.unreadCount = unreadCount
    try {
      applyUnreadBadge(process.platform, unreadCount, {
        setMacBadge: (count) => app.setBadgeCount(count),
        setWindowsOverlay: (show, description) => {
          const icon = show ? getWindowsBadgeIcon() : null
          for (const win of BrowserWindow.getAllWindows()) win.setOverlayIcon(icon, description)
        }
      })
    } catch (error) {
      console.error(`[badge] failed: ${errorMessage(error)}`)
    }
  }

  attachWindow(win: BrowserWindow): void {
    try {
      applyUnreadBadgeToWindow(process.platform, this.unreadCount, (show, description) => {
        win.setOverlayIcon(show ? getWindowsBadgeIcon() : null, description)
      })
    } catch (error) {
      console.error(`[badge] failed: ${errorMessage(error)}`)
    }
  }

  setAccountId(accountId: string | null): void {
    this.accountId = accountId
    // Nothing retained can still be actionable for the new account; the click
    // guard makes this safe either way, so this is purely releasing memory.
    this.shown.clear()
    if (!accountId) this.updateBadge(0)
  }

  notify(accountId: string, candidates: readonly NotificationCandidate[], pausedUntil: number | null): void {
    if (accountId !== this.accountId || !Notification.isSupported()) return
    const planned = planNotifications(candidates, {
      focused: BrowserWindow.getAllWindows().some((win) => win.isFocused()),
      pausedUntil
    })
    for (const item of planned) {
      const notification = new Notification({ title: item.title, body: item.body })
      const threadId = item.threadId
      // Hold the reference until the click resolves — see BoundedRetainer.
      this.shown.retain(notification)
      notification.on('click', () => {
        this.shown.release(notification)
        // Resolve against the account live *now*, not the one captured at show time.
        const target = notificationTarget(threadId, accountId, this.accountId)
        console.log(`[notify] click${target ? ` → focus ${target}` : ' → show window (no live target)'}`)
        if (target) this.focusThread(target)
        else this.showMainWindow()
      })
      notification.on('failed', () => this.shown.release(notification))
      notification.show()
    }
  }
}
