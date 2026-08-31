import {
  $setDirectionFromDOM,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type ElementDOMSlot,
  ElementNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread
} from 'lexical'
import { LEGACY_FONT_ATTRIBUTES, sanitizeComposerStyle } from '../sanitize'

const FONT_ATTRIBUTES = [...LEGACY_FONT_ATTRIBUTES, 'title'] as const
type FontAttributes = Partial<Record<(typeof FONT_ATTRIBUTES)[number], string>>
type SerializedLegacyFontNode = Spread<
  { attributes: FontAttributes; style: string; autoDirection?: boolean },
  SerializedElementNode
>

/** Gmail still emits font tags. Keep their native typography and editable children on round trips. */
export class LegacyFontNode extends ElementNode {
  __attributes: FontAttributes
  __autoDirection: boolean

  static getType(): string {
    return 'legacy-font'
  }

  static clone(node: LegacyFontNode): LegacyFontNode {
    return new LegacyFontNode(node.__attributes, node.__autoDirection, node.__key)
  }

  constructor(attributes: FontAttributes = {}, autoDirection = false, key?: NodeKey) {
    super(key)
    this.__attributes = Object.fromEntries(
      FONT_ATTRIBUTES.flatMap((name) =>
        typeof attributes[name] === 'string' ? [[name, attributes[name]]] : []
      )
    )
    // Lexical's direction field only represents explicit ltr/rtl values.
    this.__autoDirection = autoDirection
  }

  static importJSON(serialized: SerializedLegacyFontNode): LegacyFontNode {
    return new LegacyFontNode(serialized.attributes ?? {}, serialized.autoDirection === true)
      .updateFromJSON(serialized)
      .setStyle(sanitizeComposerStyle(serialized.style))
      .setTextStyle(sanitizeComposerStyle(serialized.textStyle))
  }

  static importDOM(): DOMConversionMap | null {
    return {
      font: () => ({
        conversion: (element) => {
          const source = element as HTMLElement
          const attributes = Object.fromEntries(
            FONT_ATTRIBUTES.flatMap((name) => {
              const value = source.getAttribute(name)
              return value === null ? [] : [[name, value]]
            })
          )
          const node = new LegacyFontNode(attributes, source.dir === 'auto').setStyle(
            sanitizeComposerStyle(source.getAttribute('style'))
          )
          $setDirectionFromDOM(node, source)
          return { node }
        },
        priority: 1
      })
    }
  }

  private applyAttributes(element: HTMLElement): void {
    const attributes = this.getLatest().__attributes
    for (const name of FONT_ATTRIBUTES) {
      const value = attributes[name]
      if (value === undefined) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
    const style = sanitizeComposerStyle(this.getStyle())
    if (style) element.setAttribute('style', style)
    else element.removeAttribute('style')
    const direction = this.getDirection() ?? (this.getLatest().__autoDirection ? 'auto' : null)
    if (direction) element.setAttribute('dir', direction)
    else element.removeAttribute('dir')
  }

  createDOM(_config: EditorConfig): HTMLElement {
    // Lexical reconciles direction on the outer element and removes authored auto.
    // Keep the native font in a child slot; exportDOM omits this editor-only wrapper.
    const wrapper = document.createElement('span')
    const font = document.createElement('font')
    this.applyAttributes(font)
    wrapper.append(font)
    return wrapper
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super.getDOMSlot(element.firstElementChild as HTMLElement)
  }

  updateDOM(_previous: LegacyFontNode, element: HTMLElement): false {
    this.applyAttributes(this.getDOMSlot(element).element)
    return false
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('font')
    this.applyAttributes(element)
    return { element }
  }

  exportJSON(): SerializedLegacyFontNode {
    return {
      ...super.exportJSON(),
      type: 'legacy-font',
      version: 1,
      style: this.getStyle(),
      autoDirection: this.getLatest().__autoDirection,
      attributes: { ...this.getLatest().__attributes }
    }
  }

  isInline(): true {
    return true
  }

  canBeEmpty(): false {
    return false
  }
}
