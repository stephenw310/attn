export function blurActive(): void {
  const element = document.activeElement
  if (element instanceof HTMLElement) element.blur()
}
