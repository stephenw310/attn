import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSettingKey, AccountSettings, AppSettingKey, AppSettings } from '../../../shared/settings'

export interface SettingsApi {
  /** Null until the first read lands; the settings view shows a quiet load. */
  settings: AppSettings | null
  update: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => void
}

/**
 * The app-global settings snapshot (F15). Reads and writes go through the
 * typed allowlisted bridge; every write's response is the authoritative
 * snapshot, and responses apply in dispatch order so a slow write cannot
 * overwrite a newer one.
 */
export function useSettings(onError: (message: string) => void): SettingsApi {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const writeSequenceRef = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (!window.attn) return
    let stale = false
    const sequenceAtLoad = writeSequenceRef.current
    window.attn.settings
      .getAll()
      .then((loaded) => {
        // A write dispatched while the initial read was in flight is newer.
        if (!stale && writeSequenceRef.current === sequenceAtLoad) setSettings(loaded)
      })
      .catch(() => {
        if (!stale) onErrorRef.current('Could not read settings')
      })
    return () => {
      stale = true
    }
  }, [])

  const update = useCallback(<K extends AppSettingKey>(key: K, value: AppSettings[K]): void => {
    if (!window.attn) return
    const sequence = ++writeSequenceRef.current
    // Optimistic: the control reflects the choice immediately; the response
    // (or a failure) trues it up.
    setSettings((current) => (current ? { ...current, [key]: value } : current))
    window.attn.settings
      .set(key, value)
      .then((updated) => {
        if (writeSequenceRef.current === sequence) setSettings(updated)
      })
      .catch(() => {
        onErrorRef.current('Setting could not be saved')
        void window.attn?.settings
          .getAll()
          .then((loaded) => {
            if (writeSequenceRef.current === sequence) setSettings(loaded)
          })
          .catch(() => {})
      })
  }, [])

  return { settings, update }
}

export interface AccountSettingsApi {
  accountSettings: AccountSettings | null
  updateAccountSetting: <K extends AccountSettingKey>(key: K, value: AccountSettings[K]) => void
}

/**
 * The active account's scoped settings (F18). Reads and writes bind to the
 * account current at dispatch — the utility rejects them once another account
 * is active — and this tree remounts per account, so a late completion can
 * never paint another account's controls.
 */
export function useAccountSettings(
  accountId: string | null,
  onError: (message: string) => void
): AccountSettingsApi {
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null>(null)
  const writeSequenceRef = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    setAccountSettings(null)
    if (!window.attn || !accountId) return
    let stale = false
    const sequenceAtLoad = writeSequenceRef.current
    window.attn.settings
      .getAccount(accountId)
      .then((loaded) => {
        if (!stale && writeSequenceRef.current === sequenceAtLoad) setAccountSettings(loaded)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [accountId])

  const updateAccountSetting = useCallback(
    <K extends AccountSettingKey>(key: K, value: AccountSettings[K]): void => {
      if (!window.attn || !accountId) return
      const sequence = ++writeSequenceRef.current
      setAccountSettings((current) => (current ? { ...current, [key]: value } : current))
      window.attn.settings
        .setAccount(accountId, key, value)
        .then((updated) => {
          if (writeSequenceRef.current === sequence) setAccountSettings(updated)
        })
        .catch(() => {
          onErrorRef.current('Setting could not be saved')
          void window.attn?.settings
            .getAccount(accountId)
            .then((loaded) => {
              if (writeSequenceRef.current === sequence) setAccountSettings(loaded)
            })
            .catch(() => {})
        })
    },
    [accountId]
  )

  return { accountSettings, updateAccountSetting }
}
