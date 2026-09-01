// Typed AI-writing contract shared by main, the utility process, and the
// renderer (SPEC F17, D2). The LLM client itself lives in the main process
// (src/main/ai/): the provider key comes from safeStorage, which is main-only,
// and requests go directly from the app to the user's chosen provider. This
// module declares the settings allowlist, the provider presets recorded in
// code, and the generate/stream request shapes that cross the bridge —
// anything outside these shapes is rejected at the IPC boundary.

export const AI_PROVIDER_KINDS = ['anthropic', 'openai-compatible'] as const

/**
 * The two wire protocols one interface covers (F17): the Anthropic Messages
 * API, and OpenAI-compatible chat completions — which is also how fully local
 * models (Ollama, LM Studio) connect for a zero-cloud setup.
 */
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export function isAiProviderKind(value: unknown): value is AiProviderKind {
  return AI_PROVIDER_KINDS.includes(value as AiProviderKind)
}

export const AI_VOICE_TONES = ['concise', 'friendly', 'formal'] as const

export type AiVoiceTone = (typeof AI_VOICE_TONES)[number]

export function isAiVoiceTone(value: unknown): value is AiVoiceTone {
  return AI_VOICE_TONES.includes(value as AiVoiceTone)
}

export const AI_VOICE_TONE_LABELS: Record<AiVoiceTone, string> = {
  concise: 'Concise',
  friendly: 'Friendly',
  formal: 'Formal'
}

export interface AiProviderPreset {
  label: string
  /** The sensible default model, user-changeable (F17). */
  defaultModel: string
  /** Default endpoint; only the OpenAI-compatible base URL is user-editable. */
  defaultBaseUrl: string
  baseUrlEditable: boolean
  /** Anthropic requires a key; a local OpenAI-compatible endpoint may not. */
  keyRequired: boolean
}

export const AI_PROVIDER_PRESETS: Record<AiProviderKind, AiProviderPreset> = {
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlEditable: false,
    keyRequired: true
  },
  'openai-compatible': {
    label: 'OpenAI-compatible (incl. Ollama, LM Studio)',
    defaultModel: 'llama3.1',
    // Ollama's local default; LM Studio uses http://localhost:1234/v1.
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    keyRequired: false
  }
}

/**
 * The stored, app-global AI configuration (F18 rule 9: one configuration
 * serves every signed-in account). Lives in the utility's `settings` table —
 * it contains no mail content and no credentials. The provider key is NOT
 * here: it is safeStorage-encrypted in its own file owned by main.
 */
export interface AiStoredSettings {
  /** Master switch for all AI writing; off by default (F17). */
  enabled: boolean
  /**
   * Separate, default-off consent for inline autocomplete: repeated requests
   * containing unsent draft text while typing. Enabling reply drafting never
   * enables this (F17).
   */
  autocompleteEnabled: boolean
  provider: AiProviderKind
  /** Endpoint override for OpenAI-compatible providers; null = preset default. */
  baseUrl: string | null
  /** Model override; null = the provider preset's default. */
  model: string | null
  voiceTone: AiVoiceTone
  /** Free-text standing rules ("sign off with 'Best, Chao'"). Not mail content. */
  voiceRules: string
  /** Send a few of the user's own recent sent replies as style examples (T37). */
  voiceMatchingEnabled: boolean
}

/** The renderer-facing snapshot: stored settings plus main-only key presence. */
export interface AiSettings extends AiStoredSettings {
  keyPresent: boolean
}

export const AI_SETTINGS_DEFAULTS: AiStoredSettings = {
  enabled: false,
  autocompleteEnabled: false,
  provider: 'anthropic',
  baseUrl: null,
  model: null,
  voiceTone: 'concise',
  voiceRules: '',
  voiceMatchingEnabled: false
}

export type AiSettingKey = keyof AiStoredSettings

export type AiSettingUpdate = {
  [K in AiSettingKey]: { key: K; value: AiStoredSettings[K] }
}[AiSettingKey]

const MAX_BASE_URL_LENGTH = 2_000
const MAX_MODEL_LENGTH = 200
const MAX_VOICE_RULES_LENGTH = 4_000

/**
 * Narrow one AI settings write to the allowlist. Both ends run it: main
 * before forwarding (so cancel-on-disable effects only follow a valid write)
 * and the utility before touching SQLite (the renderer is untrusted).
 */
export function validateAiSettingUpdate(key: unknown, value: unknown): AiSettingUpdate {
  switch (key) {
    case 'enabled':
    case 'autocompleteEnabled':
    case 'voiceMatchingEnabled': {
      if (typeof value !== 'boolean') throw new Error(`invalid ${key} value`)
      return { key, value }
    }
    case 'provider': {
      if (!isAiProviderKind(value)) throw new Error('invalid AI provider')
      return { key, value }
    }
    case 'baseUrl': {
      if (value === null) return { key, value }
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) {
        throw new Error('invalid AI base URL')
      }
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        throw new Error('invalid AI base URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('invalid AI base URL')
      }
      return { key, value }
    }
    case 'model': {
      if (value === null) return { key, value }
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_LENGTH) {
        throw new Error('invalid AI model')
      }
      return { key, value }
    }
    case 'voiceTone': {
      if (!isAiVoiceTone(value)) throw new Error('invalid voice tone')
      return { key, value }
    }
    case 'voiceRules': {
      if (typeof value !== 'string' || value.length > MAX_VOICE_RULES_LENGTH) {
        throw new Error('invalid voice rules')
      }
      return { key, value }
    }
    default:
      throw new Error('unknown AI setting')
  }
}

/**
 * Request purposes (F17). Reply and refine are explicit invocations carrying
 * thread context. Autocomplete is typing-triggered and carries the bounded
 * authored-body excerpt plus the current reply thread when one exists; it
 * never carries voice-matching examples.
 */
export type AiPurpose = 'reply' | 'refine' | 'autocomplete'

export interface AiThreadMessage {
  /** Display name or address of the message author, as shown in the reader. */
  author: string
  /** Plain-text body excerpt; the caller (T37) extracts and bounds it. */
  text: string
}

export interface AiReplyRequest {
  purpose: 'reply' | 'refine'
  /** Oldest-first conversation context for the reply. */
  thread: AiThreadMessage[]
  /** Refine only: the one-line instruction ("shorter", "more formal"). */
  instruction?: string
  /** Refine only: the prior AI draft being regenerated. */
  priorDraft?: string
  /**
   * Recent sent replies as style examples. Main strips these unless voice
   * matching is enabled — with the toggle off, no request may carry them.
   */
  styleExamples?: string[]
}

/** Bounds for the authored autocomplete excerpt around the caret. */
export const AUTOCOMPLETE_MAX_PREFIX_CHARS = 2_000
export const AUTOCOMPLETE_MAX_SUFFIX_CHARS = 500
/** Suggestions are one short continuation: no line breaks, at most this long. */
export const AUTOCOMPLETE_MAX_SUGGESTION_CHARS = 120

export interface AiAutocompleteRequest {
  purpose: 'autocomplete'
  /** Authored body text before the caret, already bounded by the caller. */
  prefix: string
  /** Authored body text after the caret. */
  suffix: string
  /** Current reply thread, absent for new mail and forwards without context. */
  thread?: AiThreadMessage[]
}

export type AiGenerateRequest = AiReplyRequest | AiAutocompleteRequest

const MAX_THREAD_MESSAGES = 50
const MAX_THREAD_MESSAGE_CHARS = 20_000
const MAX_STYLE_EXAMPLES = 5
const MAX_STYLE_EXAMPLE_CHARS = 10_000
const MAX_INSTRUCTION_CHARS = 1_000
const MAX_PRIOR_DRAFT_CHARS = 40_000

function isThreadMessage(value: unknown): value is AiThreadMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<AiThreadMessage>
  return (
    typeof message.author === 'string' &&
    message.author.length <= 500 &&
    typeof message.text === 'string' &&
    message.text.length <= MAX_THREAD_MESSAGE_CHARS
  )
}

/**
 * Validate a renderer generate request at the IPC boundary. Purpose decides
 * the allowed fields exactly: autocomplete may carry its disclosed thread,
 * but style examples and refine-only fields are rejected.
 */
export function parseAiGenerateRequest(value: unknown): AiGenerateRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid AI request')
  const request = value as Record<string, unknown>
  if (request.purpose === 'autocomplete') {
    const allowed = new Set(['purpose', 'prefix', 'suffix', 'thread'])
    for (const key of Object.keys(request)) {
      if (!allowed.has(key)) throw new Error('autocomplete request carries disallowed context')
    }
    const { prefix, suffix, thread } = request
    if (typeof prefix !== 'string' || prefix.length > AUTOCOMPLETE_MAX_PREFIX_CHARS) {
      throw new Error('invalid autocomplete prefix')
    }
    if (typeof suffix !== 'string' || suffix.length > AUTOCOMPLETE_MAX_SUFFIX_CHARS) {
      throw new Error('invalid autocomplete suffix')
    }
    if (
      thread !== undefined &&
      (!Array.isArray(thread) || thread.length > MAX_THREAD_MESSAGES || !thread.every(isThreadMessage))
    ) {
      throw new Error('invalid autocomplete thread context')
    }
    return {
      purpose: 'autocomplete',
      prefix,
      suffix,
      ...(thread !== undefined ? { thread: thread as AiThreadMessage[] } : {})
    }
  }
  if (request.purpose === 'reply' || request.purpose === 'refine') {
    const { thread, instruction, priorDraft, styleExamples } = request
    if (!Array.isArray(thread) || thread.length === 0 || thread.length > MAX_THREAD_MESSAGES) {
      throw new Error('invalid AI thread context')
    }
    if (!thread.every(isThreadMessage)) throw new Error('invalid AI thread context')
    if (
      instruction !== undefined &&
      (typeof instruction !== 'string' || instruction.length > MAX_INSTRUCTION_CHARS)
    ) {
      throw new Error('invalid refine instruction')
    }
    if (
      priorDraft !== undefined &&
      (typeof priorDraft !== 'string' || priorDraft.length > MAX_PRIOR_DRAFT_CHARS)
    ) {
      throw new Error('invalid prior draft')
    }
    if (styleExamples !== undefined) {
      if (
        !Array.isArray(styleExamples) ||
        styleExamples.length > MAX_STYLE_EXAMPLES ||
        !styleExamples.every(
          (example) => typeof example === 'string' && example.length <= MAX_STYLE_EXAMPLE_CHARS
        )
      ) {
        throw new Error('invalid style examples')
      }
    }
    return {
      purpose: request.purpose,
      thread: thread as AiThreadMessage[],
      ...(instruction !== undefined ? { instruction } : {}),
      ...(priorDraft !== undefined ? { priorDraft } : {}),
      ...(styleExamples !== undefined ? { styleExamples: styleExamples as string[] } : {})
    }
  }
  throw new Error('invalid AI request purpose')
}

/** One streamed generation event, broadcast main → renderer. */
export type AiStreamEvent =
  | { requestId: string; kind: 'chunk'; text: string }
  | { requestId: string; kind: 'done' }
  | { requestId: string; kind: 'error'; message: string }

/** Time given to a reply/refine stream before the transport aborts it. */
export const AI_REPLY_TIMEOUT_MS = 120_000
/** Autocomplete results older than this are canceled and discarded (F17). */
export const AI_AUTOCOMPLETE_TIMEOUT_MS = 1_500

/**
 * Autocomplete request limits, enforced in the main-process transport (F17):
 * one in flight app-wide, at most one start per second and twenty per rolling
 * minute. Limited requests are skipped — never queued or retried.
 */
export const AUTOCOMPLETE_MIN_START_INTERVAL_MS = 1_000
export const AUTOCOMPLETE_MAX_STARTS_PER_MINUTE = 20
/** Debounce after a deliberate body-typing edit before a request may start. */
export const AUTOCOMPLETE_DEBOUNCE_MS = 300
