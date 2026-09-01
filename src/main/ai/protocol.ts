// Pure request shaping and stream parsing for the two supported wire
// protocols (F17): the Anthropic Messages API and OpenAI-compatible chat
// completions. No network, no Electron — everything here is unit-testable
// data-in/data-out. The prompt builders are the privacy boundary in code:
// autocomplete receives the disclosed current thread and bounded authored
// excerpt, while voice rules and sent-mail style examples stay excluded.

import {
  AI_PROVIDER_PRESETS,
  type AiGenerateRequest,
  type AiProviderKind,
  type AiReplyRequest,
  type AiVoiceTone,
  AUTOCOMPLETE_MAX_PREFIX_CHARS,
  AUTOCOMPLETE_MAX_SUFFIX_CHARS,
  AUTOCOMPLETE_MAX_SUGGESTION_CHARS
} from '../../shared/ai'

export interface AiVoiceProfile {
  tone: AiVoiceTone
  rules: string
}

export interface AiPrompt {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
}

const TONE_INSTRUCTIONS: Record<AiVoiceTone, string> = {
  concise: 'Keep the reply brief and to the point.',
  friendly: 'Write in a warm, friendly tone.',
  formal: 'Write in a professional, formal tone.'
}

const REPLY_MAX_TOKENS = 1_024
const AUTOCOMPLETE_MAX_TOKENS = 60

function replySystem(request: AiReplyRequest, voice: AiVoiceProfile): string {
  const parts = [
    'You draft email replies for the user. Write only the reply body as plain text — no subject line, no commentary, and no signature block (the composer adds the signature separately).',
    TONE_INSTRUCTIONS[voice.tone]
  ]
  if (voice.rules.trim().length > 0) {
    parts.push(`Standing instructions from the user:\n${voice.rules.trim()}`)
  }
  const examples = request.styleExamples ?? []
  if (examples.length > 0) {
    parts.push(
      `Match the user's writing style. Recent replies the user wrote:\n${examples
        .map((example, index) => `Example ${index + 1}:\n${example}`)
        .join('\n\n')}`
    )
  }
  return parts.join('\n\n')
}

/**
 * Build the provider-neutral prompt. Reply and refine consume the thread and
 * voice profile. Autocomplete consumes its current-thread context and bounded
 * prefix/suffix, but never reads the voice profile or sent-mail examples.
 */
export function buildPrompt(request: AiGenerateRequest, voice: AiVoiceProfile): AiPrompt {
  if (request.purpose === 'autocomplete') {
    const prefix = request.prefix.slice(-AUTOCOMPLETE_MAX_PREFIX_CHARS)
    const suffix = request.suffix.slice(0, AUTOCOMPLETE_MAX_SUFFIX_CHARS)
    const conversation = (request.thread ?? [])
      .map((message) => `From ${message.author}:\n${message.text}`)
      .join('\n\n---\n\n')
    return {
      system:
        'Complete the email the user is typing. Continue directly from the text before the caret with one short continuation of at most ' +
        `${AUTOCOMPLETE_MAX_SUGGESTION_CHARS} characters and no line breaks. Use the conversation context when present. Output only the continuation text.`,
      messages: [
        {
          role: 'user',
          content:
            (conversation ? `Conversation being answered:\n\n${conversation}\n\n` : '') +
            `Text before the caret:\n${prefix}\n\nText after the caret:\n${suffix}`
        }
      ],
      maxTokens: AUTOCOMPLETE_MAX_TOKENS
    }
  }
  const conversation = request.thread
    .map((message) => `From ${message.author}:\n${message.text}`)
    .join('\n\n---\n\n')
  const content =
    request.purpose === 'refine'
      ? `Conversation:\n\n${conversation}\n\nYour previous draft reply:\n\n${request.priorDraft ?? ''}\n\n` +
        `Rewrite the draft following this instruction: ${request.instruction ?? ''}`
      : `Conversation:\n\n${conversation}\n\nWrite the user's reply to the latest message.`
  return {
    system: replySystem(request, voice),
    messages: [{ role: 'user', content }],
    maxTokens: REPLY_MAX_TOKENS
  }
}

export interface AiProviderTarget {
  provider: AiProviderKind
  /** Resolved base URL (stored override or preset default), no trailing slash. */
  baseUrl: string
  model: string
  /** Null only for a keyless OpenAI-compatible (local) endpoint. */
  key: string | null
}

export interface AiWireRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Resolve stored overrides against the preset defaults, in one place. */
export function resolveProviderTarget(
  provider: AiProviderKind,
  baseUrl: string | null,
  model: string | null,
  key: string | null
): AiProviderTarget {
  const preset = AI_PROVIDER_PRESETS[provider]
  const resolvedBase = (preset.baseUrlEditable && baseUrl ? baseUrl : preset.defaultBaseUrl).replace(
    /\/+$/,
    ''
  )
  return { provider, baseUrl: resolvedBase, model: model ?? preset.defaultModel, key }
}

/** Shape the streaming HTTP request for the target's wire protocol. */
export function buildWireRequest(target: AiProviderTarget, prompt: AiPrompt): AiWireRequest {
  if (target.provider === 'anthropic') {
    if (!target.key) throw new Error('Anthropic requires an API key')
    return {
      url: `${target.baseUrl}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': target.key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: prompt.maxTokens,
        system: prompt.system,
        messages: prompt.messages,
        stream: true
      })
    }
  }
  return {
    url: `${target.baseUrl}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      ...(target.key ? { authorization: `Bearer ${target.key}` } : {})
    },
    body: JSON.stringify({
      model: target.model,
      messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
      max_tokens: prompt.maxTokens,
      stream: true
    })
  }
}

/**
 * Incremental SSE parser for both protocols' streaming responses. Feed it
 * network chunks as they arrive; it returns the text deltas each chunk
 * completes and tolerates events split across chunk boundaries. Unknown event
 * types are skipped — both protocols interleave bookkeeping events.
 */
export class AiStreamParser {
  private buffer = ''

  constructor(private readonly provider: AiProviderKind) {}

  push(chunk: string): string[] {
    this.buffer += chunk
    const deltas: string[] = []
    let boundary = this.buffer.indexOf('\n')
    while (boundary !== -1) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, '')
      this.buffer = this.buffer.slice(boundary + 1)
      const delta = this.parseLine(line)
      if (delta !== null) deltas.push(delta)
      boundary = this.buffer.indexOf('\n')
    }
    return deltas
  }

  private parseLine(line: string): string | null {
    if (!line.startsWith('data:')) return null
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    if (this.provider === 'anthropic') {
      const event = parsed as { type?: string; delta?: { type?: string; text?: string } }
      if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
        return event.delta.text
      }
      return null
    }
    const event = parsed as { choices?: Array<{ delta?: { content?: string } }> }
    const content = event.choices?.[0]?.delta?.content
    return typeof content === 'string' ? content : null
  }
}
