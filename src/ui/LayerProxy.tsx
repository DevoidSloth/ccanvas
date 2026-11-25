import { memo } from 'react'
import type { CanvasElement, WidgetElement } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useAgents, useDisplayStatus } from '../lib/agents'
import { baseName } from '../lib/backend'
import { KIND_ICON, WidgetGlyph, showsStatus } from '../widgets/widgetIcons'
import { IconDesktop } from './icons'
import { longestWord, pathWithin, widgetGlyph, widgetType } from '../lib/layers'

// A static stand-in for one element on an overview sheet: a tile at the
// widget's own position and size. Text only, a handful of nodes: no xterm,
// Monaco or iframe.
//
// A tile has three faces, blended by custom properties the overview sets:
//  • the block (the fill): the status lamp (data-st), all that shows on a slat;
//  • the text, laid out like the canvas's far card: glyph, the name as large
//    as fits, then the status or what it is (and with V, a few lines of
//    what it shows), faded by the sheet's --txt, so it shows only while the
//    sheet is nearly flat;
//  • the widget (--m): the real widget's frame and title bar (tint and
//    folder included) crossfade in over the block, its body still the lamp,
//    so the tile lands on the canvas as a card, which then crossfades into
//    the real widget under it (the overview fades the whole sheet's content).
//
// --w, the tile's wash, fades its text in (and out), staggered down the
// sheet in reading order (layers.css).

const STATUS_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  done: 'done',
  connecting: 'connecting',
  off: 'offline',
}

const accentOf = (el: WidgetElement) =>
  el.color ?? (el.kind === 'terminal' || el.kind === 'agent' ? 'var(--accent)' : WIDGET_ACCENT[el.kind])

export type ProxyMode = 'map' | 'detail'

export const LayerProxy = memo(function LayerProxy({
  el,
  rect,
  mode = 'map',
  dim,
  ord = 0,
  noText,
  home,
}: {
  el: CanvasElement
  /** past the per-sheet cap, draw the block only */
  rect?: boolean
  /** 'map': a title, a meta line and a last line; 'detail' (V): a few lines
   *  of what the widget shows */
  mode?: ProxyMode
  /** faded out: it doesn't match the overview's find */
  dim?: boolean
  /** its place in reading order on the sheet (the dive's sweep) */
  ord?: number
  /** a tile stacked above covers its top-left corner: no text */
  noText?: boolean
  /** the layer's folder: a widget from another project says where it's from */
  home?: string
}) {
  // a minimized widget is only its title bar on the canvas: no tile for it
  if (el.type === 'widget' && el.minimized) return null
  if (el.type === 'widget')
    return rect ? (
      <div
        className="pt pt--rect"
        data-pid={el.id}
        data-ord={ord}
        data-st="kind"
        style={{ left: el.x, top: el.y, width: el.w, height: el.minimized ? 32 : el.h, ['--k2' as string]: accentOf(el), ['--k' as string]: accentOf(el) }}
      >
        <div className="pt__fill" />
        <div className="pt__real" />
      </div>
    ) : (
      <WidgetTile el={el} mode={mode} dim={dim} ord={ord} noText={noText} home={home} />
    )
  if (el.type === 'frame')
    return (
      <div
        className="pc-frame"
        style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderColor: el.color }}
      >
        {el.title && <span style={{ color: el.color }}>{el.title}</span>}
      </div>
    )
  if (el.type === 'text')
    return (
      <div className="pc-text" style={{ left: el.x, top: el.y, fontSize: el.fontSize, color: el.color }}>
        {el.text}
      </div>
    )
  if (el.type === 'image')
    return <div className="pc-image" style={{ left: el.x, top: el.y, width: el.w, height: el.h }} />
  return null
})

/** Glyph component for a widget: the desktop mirror gets its own. */
function glyphFor(el: WidgetElement) {
  return widgetGlyph(el) === 'mirror' ? IconDesktop : KIND_ICON[el.kind]
}

/** A few lines of what a non-terminal widget shows. */
function otherLines(el: WidgetElement): string[] {
  if (el.kind === 'note' && el.note)
    return el.note
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
  if (el.url) return [el.url]
  if (el.path) return [baseName(el.path), el.path]
  if (el.cmd) return [el.cmd]
  if (el.cwd) return [baseName(el.cwd)]
  return []
}

function WidgetTile({
  el,
  mode,
  dim,
  ord,
  noText,
  home,
}: {
  el: WidgetElement
  mode: ProxyMode
  dim?: boolean
  ord: number
  noText?: boolean
  home?: string
}) {
  const live = showsStatus(el)
  const shown = useDisplayStatus(el.id)
  const lastLine = useAgents((s) => (live ? s.lastLine[el.id] : undefined))
  const st = live ? (shown ?? 'off') : null
  // its brand (site or app icon) where it has one, ringed by its status
  const icon = <WidgetGlyph el={el} status={live ? st! : undefined} glyph={glyphFor(el)} className="pt__ic" />
  // a widget moved here from another project keeps its folder: say so
  const guest = home && el.cwd && !pathWithin(home, el.cwd) ? baseName(el.cwd) : null
  // under the name, as on the canvas's far card: the status, or what it is
  const meta = (live ? STATUS_WORD[st!] || '' : widgetType(el)) + (guest ? ` · ↗ ${guest}` : '')
  // V (detail) adds a few lines of what it shows
  const lines =
    mode !== 'detail'
      ? []
      : live
        ? [lastLine || '', el.cwd ? baseName(el.cwd) : ''].filter(Boolean)
        : otherLines(el).slice(0, 4)
  // the real title bar: a labelled terminal or agent is tinted, and the
  // folder follows the title (WidgetFrame)
  const tagged = (el.kind === 'terminal' || el.kind === 'agent') && !!el.color
  const folder = el.cwd ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null
  return (
    <div
      className={`pt${st ? ` pt--${st}` : ''}${dim ? ' is-dim' : ''}${tagged ? ' pt--tagged' : ''}`}
      data-pid={el.id}
      data-ord={ord}
      data-st={st ?? 'kind'}
      style={{
        left: el.x,
        top: el.y,
        width: el.w,
        // a minimized widget is just its title bar
        height: el.minimized ? 32 : el.h,
        ['--k2' as string]: accentOf(el),
        ['--k' as string]: accentOf(el),
        ['--tw' as string]: el.w,
        ['--th' as string]: el.minimized ? 32 : el.h,
        ['--chars' as string]: Math.max(6, el.title.length),
        ['--lw' as string]: longestWord(el.title),
      }}
    >
      <div className="pt__fill" />
      <div className="pt__real" />
      <div className="pt__bar">
        {icon}
        <span className="pt__bt">{el.title}</span>
        {folder && <span className="pt__cwd">{folder}</span>}
      </div>
      {!noText && (
        <div className="pt__txt">
          <div className="pt__top">
            {icon}
            <span className="pt__tt">
              <i>{el.title}</i>
            </span>
          </div>
          <span className="pt__tm">
            <i>{meta}</i>
          </span>
          <span className="pt__tls">
            {lines.map((l, i) => (
              <span key={i} className="pt__tl">
                <i>{l}</i>
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
