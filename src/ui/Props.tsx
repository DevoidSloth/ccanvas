import { useStore } from '../store/workspace'
import { PALETTE, STROKE_SIZES } from '../lib/types'

// Bottom-left popover: ink colour + stroke width for the drawing tools.
// (Agent setup lives in the new-agent wizard / the ⚙ on an agent widget.)
export function Props() {
  const color = useStore((s) => s.color)
  const setColor = useStore((s) => s.setColor)
  const strokeWidth = useStore((s) => s.strokeWidth)
  const setStrokeWidth = useStore((s) => s.setStrokeWidth)

  return (
    <div className="props">
      <span className="props__label">Color</span>
      <div className="swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`swatch${color === c ? ' swatch--active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => setColor(c)}
          />
        ))}
      </div>

      <span className="props__label">Stroke</span>
      <div className="stroke-row">
        {STROKE_SIZES.map((s) => (
          <button
            key={s}
            className={`stroke-btn${strokeWidth === s ? ' stroke-btn--active' : ''}`}
            onClick={() => setStrokeWidth(s)}
            title={`${s}px`}
          >
            <span style={{ height: s }} />
          </button>
        ))}
      </div>
    </div>
  )
}
