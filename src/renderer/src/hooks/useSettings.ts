import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSettingKey, AccountSettings, AppSettingKey, AppSettings } from '../../../shared/settings'

interface SequencedSettings<T> {
  settings: T | null
  update: (key: string, value: unknown) => void
}

/**
 * One snapshot of a settings row, read once and then kept true by its writes.
 * Reads and writes go through the typed allowlisted bridge; every write's
 * response is the authoritative snapshot, and responses apply in dispatch
 * order so a slow write cannot overwrite a newer one. `scope` names the row —
 * changing it reloads, and null means there is nothing to read yet.
 */
function useSequencedSettings<T extends object>(
  scope: string | null,
  load: (scope: string) => Promise<T>,
  save: (scope: string, key: string, value: unknown) => Promise<T>,
  onError: (phase: 'read' | 'write') => void
): SequencedSettings<T> {
  const [settings, setSettings] = useState<T | null>(null)
  const writeSequenceRef = useRef(0)
  const latest = useRef({ load, save, onError })
  latest.current = { load, save, onError }

  useEffect(() => {
    setSettings(null)
    if (!window.attn || !scope) return
    let stale = false
    const sequenceAtLoad = writeSequenceRef.current
    latest.current
      .load(scope)
      .then((loaded) => {
        // A write dispatched while the initial read was in flight is newer.
        if (!stale && writeSequenceRef.current === sequenceAtLoad) setSettings(loaded)
      })
      .catch(() => {
        if (!stale) latest.current.onError('read')
      })
    return () => {
      stale = true
    }
  }, [scope])

  const update = useCallback(
    (key: string, value: unknown): void => {
      if (!window.attn || !scope) return
      const sequence = ++writeSequenceRef.current
      // Optimistic: the control reflects the choice immediately; the response
      // (or a failure) trues it up.
      setSettings((current) => (current ? { ...current, [key]: value } : current))
      latest.current
        .save(scope, key, value)
        .then((updated) => {
          if (writeSequenceRef.current === sequence) setSettings(updated)
        })
        .catch(() => {
          latest.current.onError('write')
          void latest.current
            .load(scope)
            .then((loaded) => {
              if (writeSequenceRef.current === sequence) setSettings(loaded)
            })
            .catch(() => {})
        })
    },
    [scope]
  )

  return { settings, update }
}

export interface SettingsApi {
  /** Null until the first read lands; the settings view shows a quiet load. */
  settings: AppSettings | null
  update: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => void
}

/** The app-global settings snapshot (F15); one row, so its scope is constant. */
export function useSettings(onError: (message: string) => void): SettingsApi {
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const { settings, update } = useSequencedSettings<AppSettings>(
    'app',
    () => (window.attn as NonNullable<typeof window.attn>).settings.getAll(),
    (_scope, key, value) =>
      (window.attn as NonNullable<typeof window.attn>).settings.set(
        key as AppSettingKey,
        value as AppSettings[AppSettingKey]
      ),
    (phase) => onErrorRef.current(phase === 'read' ? 'Could not read settings' : 'Setting could not be saved')
  )
  return { settings, update: update as SettingsApi['update'] }
}

export interface AccountSettingsApi {
  accountSettings: AccountSettings | null
  updateAccountSetting: <K extends AccountSettingKey>(key: K, value: AccountSettings[K]) => void
}

/**
 * The active account's scoped settings (F18). Reads and writes bind to the
 * account current at dispatch — the utility rejects them once another account
 * is active — and this tree remounts per account, so a late completion can
 * never paint another account's controls. A failed read stays quiet: the view
 * simply shows nothing for this account yet.
 */
export function useAccountSettings(
  accountId: string | null,
  onError: (message: string) => void
): AccountSettingsApi {
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const { settings, update } = useSequencedSettings<AccountSettings>(
    accountId,
    (scope) => (window.attn as NonNullable<typeof window.attn>).settings.getAccount(scope),
    (scope, key, value) =>
      (window.attn as NonNullable<typeof window.attn>).settings.setAccount(
        scope,
        key as AccountSettingKey,
        value as AccountSettings[AccountSettingKey]
      ),
    (phase) => {
      if (phase === 'write') onErrorRef.current('Setting could not be saved')
    }
  )
  return {
    accountSettings: settings,
    updateAccountSetting: update as AccountSettingsApi['updateAccountSetting']
  }
}
