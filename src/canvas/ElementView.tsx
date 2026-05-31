import { memo } from 'react'
import getStroke from 'perfect-freehand'
import type {
  ArrowElement,
  CanvasElement,
  DrawElement,
  ShapeElement,
} from '../lib/types'
import { strokeToPath } from '../lib/geometry'

// Renders a single vector element (freehand draw, arrow, rect, ellipse) as SVG.
// Pointer events are disabled here — selection/hit-testing happens at the
// Canvas level so marquee + z-ordered picking work uniformly.

function Draw({ el }: { el: DrawElement }) {
  const pts: number[][] = []
  for (let i = 0; i < el.points.length; i += 2)
    pts.push([el.points[i], el.points[i + 1]])
  const stroke = getStroke(pts, {
    size: el.size * 2.4,
    thinning: 0.6,
    smoothing: 0.6,
    streamline: 0.5,
    last: true,
  })
  return <path d={strokeToPath(stroke)} fill={el.color} />
}

function Arrow({ el }: { el: ArrowElement }) {
  const { x1, y1, x2, y2 } = el
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.hypot(x2 - x1, y2 - y1)
  const head = Math.min(16 + el.size * 2, len * 0.4)
  const a1 = angle - Math.PI / 7
  const a2 = angle + Math.PI / 7
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  return (
    <g>
      <g
        stroke={el.color}
        strokeWidth={el.size}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          strokeDasharray={el.dashed ? `${el.size * 3} ${el.size * 2.5}` : undefined}
        />
        <path
          d={`M ${x2 - head * Math.cos(a1)} ${y2 - head * Math.sin(a1)} L ${x2} ${y2} L ${
            x2 - head * Math.cos(a2)
          } ${y2 - head * Math.sin(a2)}`}
        />
      </g>
      {el.label ? (
        <text
          x={mx}
          y={my}
          fill={el.color}
          fontSize={13}
          fontFamily="'IBM Plex Mono', ui-monospace, monospace"
          textAnchor="middle"
          dominantBaseline="central"
          stroke="#0a0b0d"
          strokeWidth={3.5}
          paintOrder="stroke"
        >
          {el.label}
        </text>
      ) : null}
    </g>
  )
}

function Shape({ el }: { el: ShapeElement }) {
  const x = el.w < 0 ? el.x + el.w : el.x
  const y = el.h < 0 ? el.y + el.h : el.y
  const w = Math.abs(el.w)
  const h = Math.abs(el.h)
  if (el.type === 'ellipse') {
    return (
      <ellipse
        cx={x + w / 2}
        cy={y + h / 2}
        rx={w / 2}
        ry={h / 2}
        stroke={el.color}
        strokeWidth={el.size}
        fill="none"
      />
    )
  }
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={Math.min(8, w / 6, h / 6)}
      stroke={el.color}
      strokeWidth={el.size}
      fill="none"
    />
  )
}

export const ElementView = memo(function ElementView({
  el,
}: {
  el: CanvasElement
}) {
  switch (el.type) {
    case 'draw':
      return <Draw el={el} />
    case 'arrow':
      return <Arrow el={el} />
    case 'rect':
    case 'ellipse':
      return <Shape el={el} />
    default:
      return null
  }
})
