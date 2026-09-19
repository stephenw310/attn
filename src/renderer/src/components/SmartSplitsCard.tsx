import { useState } from 'react'
import { TYPESAFE_DEFAULT_MODEL } from '../../../shared/ai'
import type { SplitTriageFailureCause, SplitTriageStatus } from '../../../shared/splits'
import { ACTION_BUTTON, INPUT } from './settingsStyles'

// The smart-splits surface (SPEC F11, F17). It lives on the Split rules screen
// because a description and the consent that makes it sort mail are one
// decision. The key is write-only: it is never echoed back after saving, and
// turning the feature on always shows its disclosure first.

/** What leaves the machine while smart splits run. The wording is the consent. */
export const TRIAGE_DISCLOSURE =
  'When smart splits are on, each new Inbox conversation — and every stored Inbox conversation when you ' +
  'add or edit a split description — is sent to TypeSafe using your own key. Each request carries the ' +
  "subject, the sender's name and address, the recipient count, Gmail's category labels, whether the " +
  'message came from a mailing list, the message count, and a bounded excerpt of the first and latest ' +
  'message. Judgments run ' +
  'in the background without a command, and content already sent cannot be recalled.'

const OFF_NOTE = 'Off · Write an AI rule in your own words and AI sorts mail into it.'

/** The one line that reports the classifier's progress. */
export function describeTriageStatus(status: SplitTriageStatus | null): string {
  if (!status?.enabled) return OFF_NOTE
  if (status.describedSplits === 0) return 'On · no AI rules yet'
  const splits = `${status.describedSplits} AI rule${status.describedSplits === 1 ? '' : 's'}`
  const failed = status.failedThreads
  // Conversations the classifier gave up on still count in the total: they are
  // Inbox mail with no answer, and leaving them out would move the finish line.
  const total = (status.judgedThreads + status.pendingThreads + failed).toLocaleString()
  const judged = status.judgedThreads.toLocaleString()
  if (status.pendingThreads > 0) return `On · ${splits} · judging ${judged} of ${total}…`
  // Finished work needs no number: only what is left to do, or what was lost.
  if (failed === 0) return `On · ${splits}`
  return `On · ${splits} · ${failed.toLocaleString()} could not be judged`
}

const CAUSE_NOTES: Record<SplitTriageFailureCause, string> = {
  'rate-limited': 'the service rate limited the request',
  rejected: 'the service rejected the request'
}

/** The tooltip behind the status line, or nothing while every judgment landed. */
export function describeTriageFailures(status: SplitTriageStatus | null): string | undefined {
  const failed = status?.failedThreads ?? 0
  if (!status || failed === 0) return undefined
  const count = `${failed.toLocaleString()} conversation${failed === 1 ? '' : 's'}`
  const causes = status.failedCauses.map((cause) => CAUSE_NOTES[cause]).filter(Boolean)
  const because = causes.length > 0 ? `: ${causes.join(', ')}` : ''
  return `${count} could not be judged${because}. Retry to ask again.`
}

interface SmartSplitsCardProps {
  status: SplitTriageStatus | null
  /** The masked key, never the key itself. */
  keyPreview: string | null
  /** The stored model override; null means the TypeSafe default. */
  model: string | null
  /** Re-reads the status and the AI settings after a write lands. */
  onChanged: () => void
}

export function SmartSplitsCard(props: SmartSplitsCardProps): React.JSX.Element {
  const { status, keyPreview, model, onChanged } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyPresent = status?.keyPresent ?? false
  const enabled = status?.enabled ?? false
  const modelValue = modelDraft ?? model ?? ''

  const after = (operation: Promise<unknown>, failure: string): void => {
    setError(null)
    void operation.then(onChanged).catch(() => setError(failure))
  }

  return (
    <section
      data-testid="smart-splits-card"
      aria-label="Smart splits"
      className="mb-5 flex-none rounded-md border border-edge bg-raised/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-[13rem] flex-1">
          <h3 className="text-xs font-medium text-ink">Smart splits</h3>
          <p
            data-testid="smart-splits-status"
            title={describeTriageFailures(status)}
            className="mt-1 text-[11px] leading-[1.65] text-ink-dim"
          >
            {describeTriageStatus(status)}
          </p>
          {(status?.failedThreads ?? 0) > 0 && (
            <button
              type="button"
              data-testid="smart-splits-retry"
              onClick={() =>
                after(
                  window.attn?.splits.retryTriage() ?? Promise.resolve(),
                  'The conversations could not be judged again'
                )
              }
              className={`mt-1.5 ${ACTION_BUTTON}`}
            >
              Retry
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ink-dim">
          <span>TypeSafe key</span>
          {keyPresent ? (
            <span className="flex h-[30px] items-center gap-2">
              <span data-testid="smart-splits-key-present" className="font-mono text-[11px] text-ink-dim">
                {keyPreview ?? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
              </span>
              <button
                type="button"
                data-testid="smart-splits-key-remove"
                onClick={() => {
                  setConfirming(false)
                  after(
                    window.attn?.ai.deleteTriageKey() ?? Promise.resolve(),
                    'The TypeSafe key could not be removed'
                  )
                }}
                className={ACTION_BUTTON}
              >
                Remove key
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <input
                type="password"
                data-testid="smart-splits-key"
                aria-label="TypeSafe API key"
                placeholder="Paste your TypeSafe key"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                className={`w-52 ${INPUT}`}
              />
              <button
                type="button"
                data-testid="smart-splits-key-save"
                disabled={keyDraft.trim().length === 0}
                onClick={() => {
                  const key = keyDraft.trim()
                  if (key.length === 0) return
                  setKeyDraft('')
                  after(
                    window.attn?.ai.setTriageKey(key) ?? Promise.resolve(),
                    'The TypeSafe key could not be saved'
                  )
                }}
                className={ACTION_BUTTON}
              >
                Save
              </button>
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 text-[10px] text-ink-dim">
          Model
          <span className="flex items-center gap-1.5">
            <input
              type="text"
              data-testid="smart-splits-model"
              aria-label="Smart splits model"
              placeholder={TYPESAFE_DEFAULT_MODEL}
              value={modelValue}
              onChange={(event) => setModelDraft(event.target.value)}
              className={`w-32 ${INPUT}`}
            />
            <button
              type="button"
              data-testid="smart-splits-model-apply"
              disabled={modelDraft === null}
              onClick={() => {
                const next = modelValue.trim()
                setModelDraft(null)
                after(
                  window.attn?.ai.setSetting('triageModel', next.length === 0 ? null : next) ??
                    Promise.resolve(),
                  'The model could not be saved'
                )
              }}
              className={ACTION_BUTTON}
            >
              Apply
            </button>
          </span>
        </label>
        <label className="flex flex-none items-center gap-2 text-[11px] text-ink-dim">
          <span>{enabled ? 'On' : 'Off'}</span>
          <input
            type="checkbox"
            data-testid="smart-splits-enabled"
            aria-label="Enable smart splits"
            className="app-pref-toggle"
            disabled={!keyPresent}
            checked={enabled}
            onChange={(event) => {
              if (event.target.checked) setConfirming(true)
              else {
                setConfirming(false)
                after(
                  window.attn?.ai.setSetting('triageEnabled', false) ?? Promise.resolve(),
                  'Smart splits could not be turned off'
                )
              }
            }}
          />
        </label>
      </div>

      {confirming && (
        <div
          data-testid="smart-splits-enable-confirm"
          className="mt-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2"
        >
          <p className="text-[11px] leading-[1.65] text-ink-dim">{TRIAGE_DISCLOSURE}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="smart-splits-enable-apply"
              onClick={() => {
                setConfirming(false)
                after(
                  window.attn?.ai.setSetting('triageEnabled', true) ?? Promise.resolve(),
                  'Smart splits could not be turned on'
                )
              }}
              className="cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
            >
              Enable smart splits
            </button>
            <button
              type="button"
              data-testid="smart-splits-enable-cancel"
              onClick={() => setConfirming(false)}
              className={ACTION_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2.5 text-[11px] text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
