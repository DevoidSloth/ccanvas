import { memo } from 'react'
import getStroke from 'perfect-freehand'
import type {
  ArrowElement,
  CanvasElement,
  DrawElement,
  ShapeElement,
} from '../lib/types'
import { strokeToPath, arrowControl, arrowApex } from '../lib/geometry'

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

// condition → glyph + short word for the on-canvas flow badge
const FLOW_GLYPH = { always: '⚡', success: '✓', failure: '✗', match: '~' } as const
const FLOW_WORD = {
  always: 'on finish',
  success: 'on success',
  failure: 'on failure',
  match: 'on match',
} as const

function Arrow({ el }: { el: ArrowElement }) {
  const { x1, y1, x2, y2 } = el
  const p1 = { x: x1, y: y1 }
  const p2 = { x: x2, y: y2 }
  const len = Math.hypot(x2 - x1, y2 - y1)
  const head = Math.min(16 + el.size * 2, len * 0.4)
  // curved arrows are a quadratic Bézier; the head points along the tangent at
  // the end (toward the control point), the label/badge sit on the apex
  const c = arrowControl(p1, p2, el.bend)
  const angle = el.bend ? Math.atan2(y2 - c.y, x2 - c.x) : Math.atan2(y2 - y1, x2 - x1)
  const a1 = angle - Math.PI / 7
  const a2 = angle + Math.PI / 7
  const apex = arrowApex(p1, p2, el.bend)
  const shaft = el.bend
    ? `M ${x1} ${y1} Q ${c.x} ${c.y} ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x2} ${y2}`
  // a connector wired with active logic renders in the accent colour with a
  // badge so the graph reads as an orchestration at a glance
  const flowOn = !!el.flow && el.flow.enabled !== false
  const stroke = flowOn ? '#e8975a' : el.color
  const badge = flowOn ? `${FLOW_GLYPH[el.flow!.when]} ${FLOW_WORD[el.flow!.when]}` : null
  return (
    <g>
      <g
        stroke={stroke}
        strokeWidth={el.size}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d={shaft}
          strokeDasharray={el.dashed ? `${el.size * 3} ${el.size * 2.5}` : undefined}
        />
        <path
          fill={flowOn ? stroke : 'none'}
          d={`M ${x2 - head * Math.cos(a1)} ${y2 - head * Math.sin(a1)} L ${x2} ${y2} L ${
            x2 - head * Math.cos(a2)
          } ${y2 - head * Math.sin(a2)}`}
        />
      </g>
      {el.label ? (
        <text
          x={apex.x}
          y={badge ? apex.y - 9 : apex.y}
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
      {badge ? (
        <text
          x={apex.x}
          y={el.label ? apex.y + 9 : apex.y}
          fill={stroke}
          fontSize={12}
          fontFamily="'IBM Plex Mono', ui-monospace, monospace"
          textAnchor="middle"
          dominantBaseline="central"
          stroke="#0a0b0d"
          strokeWidth={4}
          paintOrder="stroke"
        >
          {badge}
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
