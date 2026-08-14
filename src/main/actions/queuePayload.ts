export interface LabelDeltaPayload {
  add: string[]
  remove: string[]
}

export function decodeLabelDelta(payload: string): LabelDeltaPayload {
  const parsed = JSON.parse(payload) as Partial<LabelDeltaPayload>
  return { add: parsed.add ?? [], remove: parsed.remove ?? [] }
}
