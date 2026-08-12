const DARK_COLOR_SCHEME = /(\(\s*prefers-color-scheme\s*:\s*)dark(\s*\))/gi

/**
 * HTML mail is rendered on an intentionally light canvas. Chromium evaluates
 * sender-authored color-scheme media queries against the dark host app, so
 * disable only the dark branch while leaving light and responsive rules intact.
 */
export function forceLightMailCss(css: string): string {
  return css.replace(DARK_COLOR_SCHEME, '$1attn-disabled-dark$2')
}
