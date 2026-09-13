type Counters = Map<string, { value: number }[]>
export type GeneratedContent = { marker: string; before: string; after: string }

function unquote(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_match, hex: string | undefined, character: string) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character
    )
}

function formatCounter(value: number, style = 'decimal'): string {
  if (style === 'decimal-leading-zero') return String(value).padStart(2, '0')
  if (['lower-alpha', 'lower-latin', 'upper-alpha', 'upper-latin'].includes(style) && value > 0) {
    let text = ''
    while (value > 0) {
      value--
      text = String.fromCharCode(97 + (value % 26)) + text
      value = Math.floor(value / 26)
    }
    return style.startsWith('upper') ? text.toUpperCase() : text
  }
  if (['lower-roman', 'upper-roman'].includes(style) && value > 0 && value < 4000) {
    let text = ''
    for (const [number, symbol] of [
      [1000, 'M'],
      [900, 'CM'],
      [500, 'D'],
      [400, 'CD'],
      [100, 'C'],
      [90, 'XC'],
      [50, 'L'],
      [40, 'XL'],
      [10, 'X'],
      [9, 'IX'],
      [5, 'V'],
      [4, 'IV'],
      [1, 'I']
    ] as const) {
      while (value >= number) {
        text += symbol
        value -= number
      }
    }
    return style === 'lower-roman' ? text.toLowerCase() : text
  }
  return String(value)
}

/** Convert text-producing CSS content while the original counter scopes still exist. */
export function materializeGeneratedContent(root: Element, view: Window): Map<Element, GeneratedContent> {
  const result = new Map<Element, GeneratedContent>()
  let quoteDepth = 0
  const applyCounters = (style: CSSStyleDeclaration, counters: Counters): void => {
    for (const [property, defaultValue] of [
      ['counter-reset', 0],
      ['counter-set', 0],
      ['counter-increment', 1]
    ] as const) {
      const declaration = style.getPropertyValue(property)
      if (!declaration || declaration === 'none') continue
      for (const match of declaration.matchAll(/([\w-]+)(?:\s+(-?\d+))?/g)) {
        const name = match[1]
        const value = match[2] === undefined ? defaultValue : Number(match[2])
        const stack = counters.get(name) ?? []
        if (property === 'counter-reset') counters.set(name, [...stack, { value }])
        else {
          if (stack.length === 0) {
            stack.push({ value: 0 })
            counters.set(name, stack)
          }
          const counter = stack[stack.length - 1]
          if (property === 'counter-set') counter.value = value
          else counter.value += value
        }
      }
    }
  }
  const contentText = (
    content: string,
    element: Element,
    style: CSSStyleDeclaration,
    counters: Counters
  ): string => {
    const quotePairs = style.quotes.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)?.map(unquote) ?? [
      '“',
      '”',
      '‘',
      '’'
    ]
    const tokens =
      content.match(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:attr|counters?)\([^)]*\)|(?:no-)?(?:open|close)-quote/g
      ) ?? []
    let text = ''
    for (const token of tokens) {
      if (token[0] === '"' || token[0] === "'") text += unquote(token)
      else if (token.startsWith('attr(')) {
        const args = token.slice(5, -1).split(',')
        text +=
          element.getAttribute(args[0].trim().split(/\s+/)[0]) ?? (args[1] ? unquote(args[1].trim()) : '')
      } else if (token.startsWith('counter')) {
        const plural = token.startsWith('counters(')
        const args =
          token.slice(token.indexOf('(') + 1, -1).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s]+/g) ?? []
        const values = counters.get(args[0] ?? '')?.map(({ value }) => value) ?? [0]
        const style = args[plural ? 2 : 1] ?? 'decimal'
        text += plural
          ? values.map((value) => formatCounter(value, style)).join(args[1] ? unquote(args[1]) : '')
          : formatCounter(values[values.length - 1], style)
      } else {
        const opening = token.endsWith('open-quote')
        if (!opening) quoteDepth = Math.max(0, quoteDepth - 1)
        const index = Math.min(quoteDepth, Math.floor(quotePairs.length / 2) - 1) * 2 + (opening ? 0 : 1)
        if (!token.startsWith('no-') && style.quotes !== 'none') text += quotePairs[index] ?? ''
        if (opening) quoteDepth++
      }
    }
    return text
  }
  const visit = (element: Element, counters: Counters): void => {
    const style = view.getComputedStyle(element)
    if (style.display === 'none') return
    applyCounters(style, counters)
    const content: GeneratedContent = { marker: '', before: '', after: '' }
    result.set(element, content)
    const nested = new Map(counters)
    const pseudo = (side: keyof GeneratedContent): void => {
      const style = view.getComputedStyle(element, `::${side}`)
      if (!style.content || ['none', 'normal'].includes(style.content) || style.display === 'none') return
      applyCounters(style, nested)
      content[side] = contentText(style.content, element, style, nested)
    }
    pseudo('marker')
    pseudo('before')
    for (const child of element.children) visit(child, nested)
    pseudo('after')
  }
  visit(root, new Map())
  return result
}
