import { useLayoutEffect, useRef } from 'react'
import { describeUpdateStatus } from '../../../shared/distribution'
import { oneHourFrom, tomorrowStart } from '../../../shared/notifications'
import type { AccountSettingKey, AccountSettings, AppSettingKey, AppSettings } from '../../../shared/settings'
import { createCommand, registerCommands } from '../commands'
import type { SettingsControl } from '../components/SettingsView'
import { isMacPlatform } from '../platform'
import type { ShowToast } from './useToast'

interface Options {
  /** Null until the first read lands; the toggles fall back to their defaults. */
  settings: AppSettings | null
  openSettings: (control?: SettingsControl | null) => void
  /** The Split rules manager, which holds the smart-splits consent (F11). */
  openSplitRules: () => void
  openCheatSheet: () => void
  updateAppSetting: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => void
  updateAccountSetting: <K extends AccountSettingKey>(key: K, value: AccountSettings[K]) => void
  /** The palette's `Draft with AI` (T37); the draft seam owns what it does. */
  requestAiDraft: () => void
  showToast: ShowToast
}

/**
 * Every settings control is also a palette command (F5, T32 rule 5). The
 * deep-link commands open the surface focused on their control; the direct
 * ones act immediately, exactly like the tray menu. A toggle reads its current
 * value when it runs, so the batch registers once rather than on every write.
 */
export function useSettingsCommands(options: Options): void {
  const { openSettings, openSplitRules, openCheatSheet, requestAiDraft, showToast } = options
  const { updateAppSetting, updateAccountSetting } = options
  const settingsRef = useRef(options.settings)
  settingsRef.current = options.settings
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('app.closeWindow', () => {
          void window.attn?.app.closeWindow().catch(() => showToast('Could not close the window'))
        }),
        createCommand('settings.open', () => openSettings(null)),
        createCommand('settings.reorderAccounts', () => openSettings('accounts')),
        createCommand('settings.syncLimit', () => openSettings('syncLimit')),
        createCommand('compose.attnFooter.enable', () => updateAccountSetting('attnSignatureEnabled', true)),
        createCommand('compose.attnFooter.disable', () =>
          updateAccountSetting('attnSignatureEnabled', false)
        ),
        createCommand('privacy.remoteImages.block', () => updateAppSetting('remoteImagesBlocked', true)),
        createCommand('privacy.remoteImages.load', () => updateAppSetting('remoteImagesBlocked', false)),
        createCommand('privacy.remoteImages.overrides', () => openSettings('remoteImages')),
        createCommand('snippets.manage', () => openSettings('snippets')),
        createCommand('ai.settings', () => openSettings('aiWriting')),
        createCommand('ai.triageSettings', openSplitRules),
        createCommand('autocomplete.enable', () => openSettings('aiWriting')),
        createCommand('autocomplete.disable', () => {
          void window.attn?.ai
            .setSetting('autocompleteEnabled', false)
            .then(() => showToast('Inline autocomplete disabled'))
            .catch(() => {})
        }),
        createCommand('composer.aiDraft', requestAiDraft),
        createCommand('settings.undoSendDelay', () => openSettings('undoSendDelay')),
        createCommand('settings.autoAdvance', () => openSettings('autoAdvance')),
        createCommand('settings.unreadBadge', () =>
          updateAppSetting('unreadBadgeEnabled', !(settingsRef.current?.unreadBadgeEnabled ?? true))
        ),
        createCommand('settings.launchAtLogin', () =>
          updateAppSetting('launchAtLogin', !(settingsRef.current?.launchAtLogin ?? true))
        ),
        ...(isMacPlatform()
          ? [
              createCommand('settings.menuBarIcon', () =>
                updateAppSetting('menuBarIcon', !(settingsRef.current?.menuBarIcon ?? false))
              )
            ]
          : []),
        createCommand('notifications.pauseHour', () =>
          updateAppSetting('notificationsPausedUntil', oneHourFrom())
        ),
        createCommand('notifications.pauseTomorrow', () =>
          updateAppSetting('notificationsPausedUntil', tomorrowStart())
        ),
        createCommand('notifications.resume', () => updateAppSetting('notificationsPausedUntil', null)),
        createCommand('cheatsheet.open', openCheatSheet),
        createCommand('update.check', () => {
          const attn = window.attn
          if (!attn) return
          void Promise.all([attn.app.getInfo(), attn.update.check()])
            .then(([info, state]) => showToast(describeUpdateStatus(info, state, Date.now())))
            .catch(() => showToast('Could not check for updates'))
        }),
        createCommand('update.restart', () => {
          void window.attn?.update
            .restart()
            .then((applying) => {
              if (!applying) showToast('No update is ready yet')
            })
            .catch(() => {})
        })
      ]),
    [
      openCheatSheet,
      openSettings,
      openSplitRules,
      requestAiDraft,
      showToast,
      updateAccountSetting,
      updateAppSetting
    ]
  )
}
