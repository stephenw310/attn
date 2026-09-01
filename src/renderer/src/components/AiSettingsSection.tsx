import { useCallback, useEffect, useState } from 'react'
import {
  AI_PROVIDER_KINDS,
  AI_PROVIDER_PRESETS,
  AI_VOICE_TONE_LABELS,
  AI_VOICE_TONES,
  type AiSettingKey,
  type AiSettings,
  isAiProviderKind,
  isAiVoiceTone
} from '../../../shared/ai'

// The AI-writing settings pane (T36, SPEC F17). Everything here is app-global
// (F18 rule 9). Both enables are deliberate consent flows: turning one on
// shows its disclosure first, and only the confirm button writes. The key is
// write-only — it is never echoed back into the UI after saving.

const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 rounded-md px-3 py-2.5'
const NOTE = 'text-[13px] leading-[1.55] text-ink-dim'
const SELECT =
  'min-w-0 max-w-[min(21rem,45vw)] cursor-pointer rounded-md border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'
const INPUT =
  'rounded-md border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'
const ACTION_BUTTON =
  'cursor-pointer whitespace-nowrap rounded-md border border-edge px-2.5 py-1.5 text-sm text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'
const CONFIRM_PANEL = 'mx-3 mt-1 rounded-md border border-accent/40 bg-accent/10 px-3 py-2'
const CONFIRM_APPLY =
  'cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20'

const REPLY_DISCLOSURE =
  'When you invoke Draft AI reply, the open conversation, your voice profile, and — only with voice ' +
  'matching on — a few of your recent sent replies are sent directly to the provider configured below, ' +
  'using your own key. Requests happen only when you invoke the command; nothing is processed in the ' +
  'background, and content already sent to a provider cannot be recalled.'

const AUTOCOMPLETE_DISCLOSURE =
  'While you type, unsent draft text near your cursor repeatedly leaves this machine for your configured ' +
  'provider; a cloud endpoint can charge for every suggestion. Each request carries only a bounded ' +
  'excerpt of the text you typed — never the rest of the thread, recipients, or your sent mail — and ' +
  'content already sent to a provider cannot be recalled.'

export function AiSettingsSection({ onToast }: { onToast: (message: string) => void }): React.JSX.Element {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [confirming, setConfirming] = useState<'enable' | 'autocomplete' | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
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

  return (
    <div data-testid="settings-ai-controls">
      <label className={`mt-2 ${ROW}`}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">AI reply drafting</span>
          <span className={NOTE}>
            Draft replies with your own AI provider and key. Off by default; turning it on shows exactly what
            each invocation sends.
          </span>
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
          className="size-4 cursor-pointer accent-accent"
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
          <span className={NOTE}>
            Anthropic, or any OpenAI-compatible endpoint — including fully local models via Ollama or LM
            Studio for a zero-cloud setup.
          </span>
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
            <span data-testid="settings-ai-key-present" className="text-xs text-ink-dim">
              Key saved
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
          <span className="text-sm text-ink">Voice</span>
          <span className={NOTE}>The tone drafts aim for, plus standing rules every draft follows.</span>
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
          <span className="text-sm text-ink">Standing rules</span>
          <textarea
            data-testid="settings-ai-voice-rules"
            aria-label="AI standing rules"
            rows={10}
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
          className="size-4 cursor-pointer accent-accent"
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
          className="size-4 cursor-pointer accent-accent"
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
    </div>
  )
}
