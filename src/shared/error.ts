/** The one place the "unknown → readable message" ternary lives (review R5). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
