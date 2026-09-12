import { useTheme } from '../theme'
import { NOTE, ROW } from './settingsStyles'

const SWATCHES = [
  { id: 'matcha', label: 'Matcha', color: '#4f6b58' },
  { id: 'linen', label: 'Linen', color: '#796b4e' },
  { id: 'mist', label: 'Mist', color: '#4b697d' },
  { id: 'dusk', label: 'Dusk', color: '#7a5e78' }
] as const

export function PalettePicker(): React.JSX.Element {
  const { palette, setPalette } = useTheme()
  return (
    <div className={ROW}>
      <div>
        <div className="text-[13px] text-ink">Color palette</div>
        <p className={NOTE}>Shared across every account.</p>
      </div>
      <fieldset aria-label="Color palette" data-testid="palette-picker" className="flex gap-3">
        {SWATCHES.map((option) => (
          <div key={option.id} className="flex flex-col items-center gap-[7px] text-[11px] text-ink">
            <button
              type="button"
              aria-label={`${option.label} palette`}
              aria-pressed={palette === option.id}
              onClick={() => setPalette(option.id)}
              className={`size-[25px] cursor-pointer rounded-full border-2 border-black/10 shadow-[inset_0_0_0_1px_#0001] ${palette === option.id ? 'outline outline-offset-[3px] outline-accent' : ''}`}
              style={{ backgroundColor: option.color }}
            />
            <span>{option.label}</span>
          </div>
        ))}
      </fieldset>
    </div>
  )
}
