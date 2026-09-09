import { PALETTE_OPTIONS, type PaletteId } from '../../../shared/theme'
import { useTheme } from '../theme'

export function PalettePicker(): React.JSX.Element {
  const { palette, setPalette } = useTheme()
  return (
    <label className="flex items-center justify-between gap-4 py-2 text-sm text-ink-dim">
      <span>
        Color palette <span className="sr-only">for all accounts</span>
      </span>
      <select
        aria-label="Color palette"
        data-testid="palette-picker"
        className="app-field"
        value={palette}
        onChange={(event) => setPalette(event.target.value as PaletteId)}
      >
        {PALETTE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
