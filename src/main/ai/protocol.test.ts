import { describe, expect, it } from 'vitest'
import {
  type AiAutocompleteRequest,
  type AiReplyRequest,
  AUTOCOMPLETE_MAX_PREFIX_CHARS,
  AUTOCOMPLETE_MAX_SUFFIX_CHARS,
  parseAiGenerateRequest
} from '../../shared/ai'
import { AiStreamParser, buildPrompt, buildWireRequest, resolveProviderTarget } from './protocol'

const voice = { tone: 'formal', rules: "sign off with 'Best, Chao'" } as const

const replyRequest: AiReplyRequest = {
  purpose: 'reply',
  thread: [
    { author: 'Maya Lin', text: 'Can you review the roadmap?' },
    { author: 'Me', text: 'Will do.' }
  ],
  styleExamples: ['Thanks — sending it over now.']
}

describe('buildPrompt', () => {
  it('reply prompts carry the thread, tone, standing rules, and style examples', () => {
    const prompt = buildPrompt(replyRequest, voice)
    expect(prompt.system).toContain('formal')
    expect(prompt.system).toContain("sign off with 'Best, Chao'")
    expect(prompt.system).toContain('Thanks — sending it over now.')
    expect(prompt.messages).toHaveLength(1)
    expect(prompt.messages[0].content).toContain('Can you review the roadmap?')
    expect(prompt.messages[0].content).toContain('From Maya Lin:')
  })

  it('refine prompts carry the prior draft and instruction', () => {
    const prompt = buildPrompt(
      { ...replyRequest, purpose: 'refine', instruction: 'shorter', priorDraft: 'A long draft.' },
      voice
    )
    expect(prompt.messages[0].content).toContain('A long draft.')
    expect(prompt.messages[0].content).toContain('shorter')
  })

  it('autocomplete prompts contain only the bounded excerpt — never voice or examples', () => {
    const request: AiAutocompleteRequest = {
      purpose: 'autocomplete',
      prefix: 'x'.repeat(AUTOCOMPLETE_MAX_PREFIX_CHARS + 500) + 'BEFORE',
      suffix: 'AFTER' + 'y'.repeat(AUTOCOMPLETE_MAX_SUFFIX_CHARS + 500)
    }
    const prompt = buildPrompt(request, voice)
    const payload = prompt.system + prompt.messages.map((message) => message.content).join('')
    expect(payload).not.toContain('Best, Chao')
    expect(payload).not.toContain('formal')
    expect(payload).toContain('BEFORE')
    expect(payload).toContain('AFTER')
    // The excerpt is truncated to the disclosed bounds: prefix keeps its tail
    // (the text at the caret), suffix its head.
    const content = prompt.messages[0].content
    const beforeSection = content.slice(0, content.indexOf('Text after the caret:'))
    expect(beforeSection.length).toBeLessThan(AUTOCOMPLETE_MAX_PREFIX_CHARS + 100)
    expect(content.endsWith('AFTER' + 'y'.repeat(AUTOCOMPLETE_MAX_SUFFIX_CHARS - 5))).toBe(true)
  })
})

describe('parseAiGenerateRequest', () => {
  it('rejects an autocomplete request smuggling reply context', () => {
    expect(() =>
      parseAiGenerateRequest({
        purpose: 'autocomplete',
        prefix: 'Hi',
        suffix: '',
        thread: [{ author: 'a', text: 'b' }]
      })
    ).toThrow(/disallowed context/)
    expect(() =>
      parseAiGenerateRequest({ purpose: 'autocomplete', prefix: 'Hi', suffix: '', styleExamples: ['x'] })
    ).toThrow(/disallowed context/)
  })

  it('rejects oversized excerpts rather than trimming silently', () => {
    expect(() =>
      parseAiGenerateRequest({
        purpose: 'autocomplete',
        prefix: 'x'.repeat(AUTOCOMPLETE_MAX_PREFIX_CHARS + 1),
        suffix: ''
      })
    ).toThrow(/prefix/)
  })

  it('accepts a well-formed reply request and unknown purposes fail', () => {
    expect(parseAiGenerateRequest(replyRequest)).toMatchObject({ purpose: 'reply' })
    expect(() => parseAiGenerateRequest({ purpose: 'summarize', thread: [] })).toThrow(/purpose/)
  })
})

describe('buildWireRequest', () => {
  const prompt = buildPrompt(replyRequest, voice)

  it('shapes the Anthropic Messages request with key header and version', () => {
    const target = resolveProviderTarget('anthropic', null, null, 'sk-ant-test')
    const wire = buildWireRequest(target, prompt)
    expect(wire.url).toBe('https://api.anthropic.com/v1/messages')
    expect(wire.headers['x-api-key']).toBe('sk-ant-test')
    expect(wire.headers['anthropic-version']).toBeTruthy()
    const body = JSON.parse(wire.body)
    expect(body.stream).toBe(true)
    expect(body.system).toBe(prompt.system)
    expect(body.messages).toEqual(prompt.messages)
    expect(typeof body.model).toBe('string')
  })

  it('anthropic without a key is an error, never a keyless request', () => {
    const target = resolveProviderTarget('anthropic', null, null, null)
    expect(() => buildWireRequest(target, prompt)).toThrow(/key/)
  })

  it('shapes the OpenAI-compatible request with bearer auth and system message', () => {
    const target = resolveProviderTarget(
      'openai-compatible',
      'http://localhost:1234/v1/',
      'my-model',
      'lm-key'
    )
    const wire = buildWireRequest(target, prompt)
    expect(wire.url).toBe('http://localhost:1234/v1/chat/completions')
    expect(wire.headers.authorization).toBe('Bearer lm-key')
    const body = JSON.parse(wire.body)
    expect(body.model).toBe('my-model')
    expect(body.messages[0]).toEqual({ role: 'system', content: prompt.system })
    expect(body.stream).toBe(true)
  })

  it('a keyless OpenAI-compatible (local) request sends no auth header', () => {
    const target = resolveProviderTarget('openai-compatible', null, null, null)
    const wire = buildWireRequest(target, prompt)
    expect(wire.headers.authorization).toBeUndefined()
    expect(wire.url).toContain('localhost:11434')
  })
})

describe('AiStreamParser', () => {
  it('extracts Anthropic content deltas and skips bookkeeping events', () => {
    const parser = new AiStreamParser('anthropic')
    const chunk =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n'
    expect(parser.push(chunk)).toEqual(['Hel', 'lo'])
  })

  it('extracts OpenAI deltas and stops cleanly at [DONE]', () => {
    const parser = new AiStreamParser('openai-compatible')
    const chunk =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"Hi "}}]}\n' +
      'data: {"choices":[{"delta":{"content":"there"}}]}\n' +
      'data: [DONE]\n'
    expect(parser.push(chunk)).toEqual(['Hi ', 'there'])
  })

  it('tolerates events split across network chunks', () => {
    const parser = new AiStreamParser('openai-compatible')
    expect(parser.push('data: {"choices":[{"delta":{"con')).toEqual([])
    expect(parser.push('tent":"split"}}]}\n')).toEqual(['split'])
  })

  it('ignores malformed data lines rather than failing the stream', () => {
    const parser = new AiStreamParser('anthropic')
    expect(parser.push('data: {not json}\ndata: 42\n')).toEqual([])
  })
})
