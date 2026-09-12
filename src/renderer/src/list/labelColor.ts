const LABEL_PALETTE = [
  {
    backgroundColor: 'var(--attn-label-1-bg)',
    borderColor: 'var(--attn-label-1-edge)',
    color: 'var(--attn-label-1-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-2-bg)',
    borderColor: 'var(--attn-label-2-edge)',
    color: 'var(--attn-label-2-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-3-bg)',
    borderColor: 'var(--attn-label-3-edge)',
    color: 'var(--attn-label-3-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-4-bg)',
    borderColor: 'var(--attn-label-4-edge)',
    color: 'var(--attn-label-4-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-5-bg)',
    borderColor: 'var(--attn-label-5-edge)',
    color: 'var(--attn-label-5-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-6-bg)',
    borderColor: 'var(--attn-label-6-edge)',
    color: 'var(--attn-label-6-ink)'
  }
] as const

function labelPalette(labelId: string): (typeof LABEL_PALETTE)[number] {
  let hash = 0
  for (const character of labelId) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length]
}

export function labelMarkerColor(labelId: string): string {
  return labelPalette(labelId).color
}

export function labelColor(labelId: string): { backgroundColor: string; borderColor: string; color: string } {
  const palette = labelPalette(labelId)
  return {
    backgroundColor: `color-mix(in srgb, ${palette.borderColor} 13%, var(--attn-ground))`,
    borderColor: `color-mix(in srgb, ${palette.borderColor} 65%, var(--attn-edge))`,
    color: 'var(--attn-ink)'
  }
}
