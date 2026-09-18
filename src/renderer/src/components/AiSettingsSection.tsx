import { useCallback, useEffect, useState } from 'react'
import {
  AI_PROVIDER_KINDS,
  AI_PROVIDER_PRESETS,
  AI_VOICE_TONE_LABELS,
  AI_VOICE_TONES,
  type AiSettingKey,
  type AiSettings,
  isAiProviderKind,
  isAiVoiceTone,
  TYPESAFE_DEFAULT_MODEL
} from '../../../shared/ai'
import { useShowToast } from '../toastContext'
import { ACTION_BUTTON, INPUT, NOTE, ROW, SELECT } from './settingsStyles'

// The AI settings pane (T36, SPEC F17). Everything here is app-global (F18
// rule 9). Every enable is a deliberate consent flow: turning one on shows its
// disclosure first, and only the confirm button writes. Keys are write-only —
// they are never echoed back into the UI after saving. Smart splits carry
// their own consent and their own TypeSafe key, so a user may run either
// feature alone.

const CONFIRM_PANEL = 'mx-3 mt-1 rounded-md border border-accent/40 bg-accent/10 px-3 py-2'
const CONFIRM_APPLY =
  'cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20'

const REPLY_DISCLOSURE =
  'When you invoke Draft AI reply, the open conversation, any reply text you have already written, your ' +
  'voice profile, and — only with voice matching on — a few of your recent sent replies are sent directly ' +
  'to the provider configured below, using your own key. Requests happen only when you invoke the command; ' +
  'nothing is processed in the background, and content already sent to a provider cannot be recalled.'

const AUTOCOMPLETE_DISCLOSURE =
  'While you type, unsent draft text near your cursor repeatedly leaves this machine for your configured ' +
  'provider; a cloud endpoint can charge for every suggestion. Each request carries only a bounded ' +
  'excerpt of the text you typed, the current subject, your selected tone and standing rules, and, for ' +
  'replies, the current email thread. It never includes recipients, attachments, signatures, or unrelated ' +
  'sent mail, and ' +
  'content already sent to a provider cannot be recalled.'

const TRIAGE_DISCLOSURE =
  'When smart splits are on, each new Inbox conversation — and every stored Inbox conversation when you ' +
  'add or edit a split description — is sent to TypeSafe using your own key. Each request carries the ' +
  "subject, the sender's name and address, the recipient count, Gmail's category labels, whether the " +
  'message came from a mailing list, the message count, and a bounded excerpt of the first and latest ' +
  'message. Judgments run ' +
  'in the background without a command, and content already sent cannot be recalled.'

export function AiSettingsSection(): React.JSX.Element {
  const onToast = useShowToast()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [confirming, setConfirming] = useState<'enable' | 'autocomplete' | 'triage' | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [triageKeyDraft, setTriageKeyDraft] = useState('')
  const [triageModelDraft, setTriageModelDraft] = useState<string | null>(null)
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const [rulesDraft, setRulesDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!window.attn) return
    let stale = false
    window.attn.ai
      .getSettings()
      .then((loaded) => {
        if (!stale) setSettings(loaded)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  const write = useCallback(
    <K extends AiSettingKey>(key: K, value: AiSettings[K]) => {
      void window.attn?.ai
        .setSetting(key, value)
        .then(setSettings)
        .catch(() => onToast('The AI setting could not be saved'))
    },
    [onToast]
  )

  const preset = AI_PROVIDER_PRESETS[settings?.provider ?? 'anthropic']
  const baseUrlValue = baseUrlDraft ?? settings?.baseUrl ?? ''
  const modelValue = modelDraft ?? settings?.model ?? ''
  const rulesValue = rulesDraft ?? settings?.voiceRules ?? ''
  const triageModelValue = triageModelDraft ?? settings?.triageModel ?? ''

  const saveKey = useCallback(() => {
    const key = keyDraft.trim()
    if (key.length === 0) return
    void window.attn?.ai
      .setKey(key)
      .then((next) => {
        setSettings(next)
        setKeyDraft('')
      })
      .catch(() => onToast('The key could not be saved'))
  }, [keyDraft, onToast])

  const removeKey = useCallback(() => {
    void window.attn?.ai
      .deleteKey()
      .then(setSettings)
      .catch(() => onToast('The key could not be removed'))
  }, [onToast])

  const saveTriageKey = useCallback(() => {
    const key = triageKeyDraft.trim()
    if (key.length === 0) return
    void window.attn?.ai
      .setTriageKey(key)
      .then((next) => {
        setSettings(next)
        setTriageKeyDraft('')
      })
      .catch(() => onToast('The TypeSafe key could not be saved'))
  }, [triageKeyDraft, onToast])

  const removeTriageKey = useCallback(() => {
    setConfirming((current) => (current === 'triage' ? null : current))
    void window.attn?.ai
      .deleteTriageKey()
      .then(setSettings)
      .catch(() => onToast('The TypeSafe key could not be removed'))
  }, [onToast])

  return (
    <div data-testid="settings-ai-controls">
      <label className={`mt-2 ${ROW}`}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Enable AI writing</span>
          <span className={NOTE}>Use your provider to help draft replies.</span>
        </span>
        <input
          type="checkbox"
          data-testid="settings-ai-enabled"
          data-settings-control="aiWriting"
          aria-label="Enable AI reply drafting"
          disabled={!settings}
          checked={settings?.enabled ?? false}
          onChange={(event) => {
            if (event.target.checked) setConfirming('enable')
            else {
              setConfirming(null)
              write('enabled', false)
            }
          }}
          className="app-pref-toggle"
        />
      </label>
      {confirming === 'enable' && (
        <div data-testid="settings-ai-enable-confirm" className={CONFIRM_PANEL}>
          <p className="text-[12px] leading-relaxed text-ink-dim">{REPLY_DISCLOSURE}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="settings-ai-enable-apply"
              onClick={() => {
                setConfirming(null)
                write('enabled', true)
              }}
              className={CONFIRM_APPLY}
            >
              Enable AI reply drafting
            </button>
            <button
              type="button"
              data-testid="settings-ai-enable-cancel"
              onClick={() => setConfirming(null)}
              className={ACTION_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Provider</span>
          <span className={NOTE}>Your configuration is shared by every account.</span>
        </span>
        <select
          data-testid="settings-ai-provider"
          aria-label="AI provider"
          disabled={!settings}
          value={settings?.provider ?? 'anthropic'}
          onChange={(event) => {
            if (isAiProviderKind(event.target.value)) {
              setBaseUrlDraft(null)
              setModelDraft(null)
              write('provider', event.target.value)
            }
          }}
          className={SELECT}
        >
          {AI_PROVIDER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {AI_PROVIDER_PRESETS[kind].label}
            </option>
          ))}
        </select>
      </div>

      {preset.baseUrlEditable && (
        <div className={ROW}>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm text-ink">Endpoint URL</span>
            <span className={NOTE}>The chat-completions base URL, e.g. {preset.defaultBaseUrl}.</span>
          </span>
          <span className="flex flex-none items-center gap-1.5">
            <input
              type="text"
              data-testid="settings-ai-base-url"
              aria-label="AI endpoint URL"
              placeholder={preset.defaultBaseUrl}
              value={baseUrlValue}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              className={`w-56 ${INPUT}`}
            />
            <button
              type="button"
              data-testid="settings-ai-base-url-apply"
              disabled={baseUrlDraft === null}
              onClick={() => {
                setBaseUrlDraft(null)
                write('baseUrl', baseUrlValue.trim().length === 0 ? null : baseUrlValue.trim())
              }}
              className={ACTION_BUTTON}
            >
              Apply
            </button>
          </span>
        </div>
      )}

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Model</span>
          <span className={NOTE}>Leave empty for the provider default ({preset.defaultModel}).</span>
        </span>
        <span className="flex flex-none items-center gap-1.5">
          <input
            type="text"
            data-testid="settings-ai-model"
            aria-label="AI model"
            placeholder={preset.defaultModel}
            value={modelValue}
            onChange={(event) => setModelDraft(event.target.value)}
            className={`w-44 ${INPUT}`}
          />
          <button
            type="button"
            data-testid="settings-ai-model-apply"
            disabled={modelDraft === null}
            onClick={() => {
              setModelDraft(null)
              write('model', modelValue.trim().length === 0 ? null : modelValue.trim())
            }}
            className={ACTION_BUTTON}
          >
            Apply
          </button>
        </span>
      </div>

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">API key</span>
          <span className={NOTE}>
            Stored encrypted by the OS, separate from your Google sign-in; removing it disables both AI
            features and never touches your accounts. Local endpoints may not need one.
          </span>
        </span>
        {settings?.keyPresent ? (
          <span className="flex flex-none items-center gap-1.5">
            <span data-testid="settings-ai-key-present" className="font-mono text-xs text-ink-dim">
              {settings.keyPreview ?? '••••••••'}
            </span>
            <button
              type="button"
              data-testid="settings-ai-key-remove"
              onClick={removeKey}
              className={ACTION_BUTTON}
            >
              Remove key
            </button>
          </span>
        ) : (
          <span className="flex flex-none items-center gap-1.5">
            <input
              type="password"
              data-testid="settings-ai-key-input"
              aria-label="AI provider API key"
              placeholder="Paste your key"
              disabled={!settings}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              className={`w-56 ${INPUT}`}
            />
            <button
              type="button"
              data-testid="settings-ai-key-save"
              disabled={keyDraft.trim().length === 0}
              onClick={saveKey}
              className={ACTION_BUTTON}
            >
              Save
            </button>
          </span>
        )}
      </div>

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Voice tone</span>
          <span className={NOTE}>Default tone for AI writing.</span>
        </span>
        <select
          data-testid="settings-ai-voice-tone"
          aria-label="AI voice tone"
          disabled={!settings}
          value={settings?.voiceTone ?? 'concise'}
          onChange={(event) => {
            if (isAiVoiceTone(event.target.value)) write('voiceTone', event.target.value)
          }}
          className={SELECT}
        >
          {AI_VOICE_TONES.map((tone) => (
            <option key={tone} value={tone}>
              {AI_VOICE_TONE_LABELS[tone]}
            </option>
          ))}
        </select>
      </div>

      <div className={`${ROW} items-start`}>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-sm text-ink">Writing rules</span>
          <textarea
            data-testid="settings-ai-voice-rules"
            aria-label="AI standing rules"
            rows={4}
            placeholder={'e.g. sign off with "Best, Chao"; never use exclamation marks'}
            disabled={!settings}
            value={rulesValue}
            onChange={(event) => setRulesDraft(event.target.value)}
            className={`w-full resize-none ${INPUT}`}
          />
        </span>
        <button
          type="button"
          data-testid="settings-ai-voice-rules-apply"
          disabled={rulesDraft === null}
          onClick={() => {
            setRulesDraft(null)
            write('voiceRules', rulesValue)
          }}
          className={`${ACTION_BUTTON} self-end`}
        >
          Apply
        </button>
      </div>

      <label className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Match my writing voice</span>
          <span className={NOTE}>
            Sends a few of your recent sent replies with each explicit draft request as style examples. Never
            used for autocomplete.
          </span>
        </span>
        <input
          type="checkbox"
          data-testid="settings-ai-voice-matching"
          aria-label="Match my writing voice"
          disabled={!settings}
          checked={settings?.voiceMatchingEnabled ?? false}
          onChange={(event) => write('voiceMatchingEnabled', event.target.checked)}
          className="app-pref-toggle"
        />
      </label>

      <label className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Inline autocomplete</span>
          <span className={NOTE}>
            A separate opt-in: short gray suggestions while you type. Enabling reply drafting alone never
            turns this on.
          </span>
        </span>
        <input
          type="checkbox"
          data-testid="settings-ai-autocomplete"
          aria-label="Enable inline autocomplete"
          disabled={!settings?.enabled}
          checked={settings?.autocompleteEnabled ?? false}
          onChange={(event) => {
            if (event.target.checked) setConfirming('autocomplete')
            else {
              setConfirming(null)
              write('autocompleteEnabled', false)
            }
          }}
          className="app-pref-toggle"
        />
      </label>
      {confirming === 'autocomplete' && (
        <div data-testid="settings-ai-autocomplete-confirm" className={CONFIRM_PANEL}>
          <p className="text-[12px] leading-relaxed text-ink-dim">{AUTOCOMPLETE_DISCLOSURE}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="settings-ai-autocomplete-apply"
              onClick={() => {
                setConfirming(null)
                write('autocompleteEnabled', true)
              }}
              className={CONFIRM_APPLY}
            >
              Enable autocomplete
            </button>
            <button
              type="button"
              data-testid="settings-ai-autocomplete-cancel"
              onClick={() => setConfirming(null)}
              className={ACTION_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <h4 className="mb-2 mt-[29px] text-[15px] font-medium text-ink">Smart splits</h4>

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">TypeSafe key</span>
          <span className={NOTE}>
            Stored encrypted by the OS in its own file. Removing it turns smart splits off and never touches
            your AI writing key or your accounts.
          </span>
        </span>
        {settings?.triageKeyPresent ? (
          <span className="flex flex-none items-center gap-1.5">
            <span data-testid="settings-ai-triage-key-present" className="font-mono text-xs text-ink-dim">
              {settings.triageKeyPreview ?? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
            </span>
            <button
              type="button"
              data-testid="settings-ai-triage-key-remove"
              onClick={removeTriageKey}
              className={ACTION_BUTTON}
            >
              Remove key
            </button>
          </span>
        ) : (
          <span className="flex flex-none items-center gap-1.5">
            <input
              type="password"
              data-testid="settings-ai-triage-key"
              aria-label="TypeSafe API key"
              placeholder="Paste your TypeSafe key"
              disabled={!settings}
              value={triageKeyDraft}
              onChange={(event) => setTriageKeyDraft(event.target.value)}
              className={`w-56 ${INPUT}`}
            />
            <button
              type="button"
              data-testid="settings-ai-triage-key-save"
              disabled={triageKeyDraft.trim().length === 0}
              onClick={saveTriageKey}
              className={ACTION_BUTTON}
            >
              Save
            </button>
          </span>
        )}
      </div>

      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Judgment model</span>
          <span className={NOTE}>Leave empty for the TypeSafe default ({TYPESAFE_DEFAULT_MODEL}).</span>
        </span>
        <span className="flex flex-none items-center gap-1.5">
          <input
            type="text"
            data-testid="settings-ai-triage-model"
            aria-label="Smart splits model"
            placeholder={TYPESAFE_DEFAULT_MODEL}
            value={triageModelValue}
            onChange={(event) => setTriageModelDraft(event.target.value)}
            className={`w-44 ${INPUT}`}
          />
          <button
            type="button"
            data-testid="settings-ai-triage-model-apply"
            disabled={triageModelDraft === null}
            onClick={() => {
              setTriageModelDraft(null)
              write('triageModel', triageModelValue.trim().length === 0 ? null : triageModelValue.trim())
            }}
            className={ACTION_BUTTON}
          >
            Apply
          </button>
        </span>
      </div>

      <label className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Judge conversations against split descriptions</span>
          <span className={NOTE}>
            {settings?.triageKeyPresent
              ? 'A separate opt-in from AI writing: TypeSafe sorts Inbox mail into your splits in the background.'
              : 'Save a TypeSafe key above to turn this on.'}
          </span>
        </span>
        <input
          type="checkbox"
          data-testid="settings-ai-triage-enabled"
          data-settings-control="aiTriage"
          aria-label="Enable smart splits"
          disabled={!settings?.triageKeyPresent}
          checked={settings?.triageEnabled ?? false}
          onChange={(event) => {
            if (event.target.checked) setConfirming('triage')
            else {
              setConfirming(null)
              write('triageEnabled', false)
            }
          }}
          className="app-pref-toggle"
        />
      </label>
      {confirming === 'triage' && (
        <div data-testid="settings-ai-triage-enable-confirm" className={CONFIRM_PANEL}>
          <p className="text-[12px] leading-relaxed text-ink-dim">{TRIAGE_DISCLOSURE}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="settings-ai-triage-enable-apply"
              onClick={() => {
                setConfirming(null)
                write('triageEnabled', true)
              }}
              className={CONFIRM_APPLY}
            >
              Enable smart splits
            </button>
            <button
              type="button"
              data-testid="settings-ai-triage-enable-cancel"
              onClick={() => setConfirming(null)}
              className={ACTION_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
