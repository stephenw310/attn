/**
 * A view name, with its first letter lettered in red as a scribe opens a page.
 * The rest of the name keeps the text face, so the whole title still reads as
 * one word to a screen reader and to a test.
 */
/**
 * The first grapheme, not the first code point: a label can open with an emoji
 * built from a joined sequence, a flag, or a skin-tone modifier, and cutting it
 * in half would letter half a glyph in red.
 */
function firstGrapheme(title: string): string {
  const segmenter =
    Intl.Segmenter === undefined ? null : new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  if (segmenter) return segmenter.segment(title)[Symbol.iterator]().next().value?.segment ?? ''
  return title.match(/^.\p{M}*\uFE0F?/u)?.[0] ?? ''
}

export function ViewTitle({ title }: { title: string }): React.JSX.Element {
  const initial = firstGrapheme(title)
  return (
    <>
      <span className="font-gotisch text-[30px] text-accent">{initial}</span>
      {title.slice(initial.length)}
    </>
  )
}
