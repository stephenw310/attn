export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024

export function inlineImageIsTooLarge(byteLength: number): boolean {
  return byteLength > MAX_INLINE_IMAGE_BYTES
}
