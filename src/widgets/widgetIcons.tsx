// Icons per widget kind and the activity dot for terminals/agents — shared by
// the widget title bar and the stack tab rail.

import type { WidgetElement, WidgetKind } from '../lib/types'
import { useDisplayStatus, type AgentStatus } from '../lib/agents'
import {
  IconNote,
  IconTerminal,
  IconWeb,
  IconAgent,
  IconFiles,
  IconDiff,
  IconEditor,
  IconDoc,
  IconLog,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
  IconDatabase,
  IconData,
  IconPlot,
  IconChat,
  IconVideo,
  IconClaude,
  IconInfo,
  IconMusic,
} from '../ui/icons'
import { useNowPlaying } from '../lib/nowplaying'
import { brandSource, useBrandImage, useWebPage, type BrandSource } from '../lib/brandIcon'

export const KIND_ICON: Record<WidgetKind, (p: { className?: string; size?: number }) => JSX.Element> = {
  terminal: IconTerminal,
  agent: IconAgent,
  web: IconWeb,
  note: IconNote,
  files: IconFiles,
  diff: IconDiff,
  editor: IconEditor,
  vscode: IconEditor,
  doc: IconDoc,
  log: IconLog,
  pr: IconPr,
  issues: IconIssue,
  runs: IconChecks,
  runner: IconRun,
  sql: IconDatabase,
  data: IconData,
  plot: IconPlot,
  transcript: IconChat,
  video: IconVideo,
  mediainfo: IconInfo,
  claude: IconClaude,
  nowplaying: IconMusic,
}

// ---- status icons ----
// A terminal, agent or desktop mirror shows its status in the icon slot instead of a blinking
// dot next to it: a spinning arc while it works, a steady amber dot when it
// needs you (it pings once as that starts, then stays still), a check for a
// couple of minutes after it finishes, and its ordinary kind icon when idle.
// Motion is kept for "busy"; "needs you" is colour and shape.

export type ShownStatus = AgentStatus | 'done' | undefined

const STATUS_TITLE: Record<string, string> = {
  working: 'working…',
  waiting: 'waiting for input',
  connecting: 'connecting…',
  done: 'just finished',
  idle: 'idle',
  off: 'offline',
}

const SPINNER = (
  <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="8" cy="8" r="5.5" className="status-icon__track" />
    <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="status-icon__arc" />
  </svg>
)
const WAITING = (
  <svg viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="4" className="status-icon__fill" />
    <circle cx="8" cy="8" r="6.3" fill="none" strokeWidth="1.4" className="status-icon__halo" />
  </svg>
)
const DONE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
)
const IDLE_DOT = (
  <svg viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="3" className="status-icon__fill" />
  </svg>
)

/** A status, drawn in an icon slot. `icon` is what idle (and offline) shows.
 *  With `brand` (a site or app icon), the icon always shows and the status
 *  rings it instead: the spinning arc while it works, the amber halo when it
 *  needs you, a check badge when it's just done. */
export function StatusGlyph({
  status,
  icon,
  brand,
  title,
  className = '',
}: {
  status: ShownStatus | 'off'
  icon?: React.ReactNode
  brand?: React.ReactNode
  title?: string
  className?: string
}) {
  const s = status ?? 'off'
  if (brand) {
    const ring =
      s === 'working' || s === 'connecting' ? (
        <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" strokeLinecap="round" className="status-icon__ring">
          <circle cx="8" cy="8" r="7.2" className="status-icon__track" />
          <path d="M8 0.8a7.2 7.2 0 0 1 7.2 7.2" className="status-icon__arc" />
        </svg>
      ) : s === 'waiting' ? (
        <svg viewBox="0 0 16 16" fill="none" className="status-icon__ring">
          <circle cx="8" cy="8" r="7.2" strokeWidth="1.6" className="status-icon__halo" />
        </svg>
      ) : null
    return (
      <span
        className={`status-icon status-icon--${s} status-icon--brand${ring ? ' status-icon--ringed' : ''} ${className}`}
        title={title ?? STATUS_TITLE[s]}
      >
        <span className="status-icon__brand">{brand}</span>
        {ring}
        {s === 'done' && <span className="status-icon__badge">{DONE}</span>}
      </span>
    )
  }
  const body =
    s === 'working' || s === 'connecting' ? SPINNER : s === 'waiting' ? WAITING : s === 'done' ? DONE : (icon ?? IDLE_DOT)
  return (
    <span className={`status-icon status-icon--${s} ${className}`} title={title ?? STATUS_TITLE[s]}>
      {body}
    </span>
  )
}

/** Widgets with a live status: terminals, agents, and desktop-app mirrors
 *  (whose status is read from their transcript, see useMirrorStatusSync). */
export const showsStatus = (w: WidgetElement): boolean =>
  w.kind === 'terminal' || w.kind === 'agent' || w.mirrorOf === 'desktop'

/** A live terminal/agent's (or desktop mirror's) status in its icon slot. */
export function StatusIcon({ id, kind, className }: { id: string; kind: WidgetKind; className?: string }) {
  const status = useDisplayStatus(id)
  const Icon = KIND_ICON[kind]
  return <StatusGlyph status={status} icon={<Icon />} className={className} />
}

// ---- brand icons (lib/brandIcon.ts) ----

/** GitHub's mark (Octicons, MIT), for the PR, issues and runs widgets. */
const GITHUB_MARK = (
  <svg viewBox="0 0 16 16" className="brand-mark brand-mark--github" aria-hidden>
    <path
      fill="currentColor"
      d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
    />
  </svg>
)

/** A widget's brand icon as an element (an <img> of a site or app icon, or
 *  GitHub's mark), or null: then its kind's glyph shows. */
export function useBrand(el: WidgetElement): React.ReactNode {
  const page = useWebPage(el)
  const npSource = useNowPlaying((s) => (el.kind === 'nowplaying' && s.np.kind === 'track' ? s.np.track.source : null))
  const src: BrandSource = brandSource(el, page, npSource)
  const img = useBrandImage(src)
  if (!src) return null
  if (src.kind === 'github') return GITHUB_MARK
  // a site's icon sits on a light tile, as browsers show favourites: many are
  // drawn for a white page (GitHub's is black), and the cards are dark
  if (img)
    return src.kind === 'site' ? (
      <span className="brand-tile">
        <img src={img} alt="" draggable={false} className="brand-img" />
      </span>
    ) : (
      <img src={img} alt="" draggable={false} className="brand-img" />
    )
  if (src.kind === 'app' && src.fallback === 'claude') return <IconClaude />
  return null
}

/** A widget's icon anywhere it is drawn (title bar, card, tile, strip): its
 *  brand where it has one, its kind's glyph otherwise; with its live status
 *  where it has one. `glyph` overrides the kind glyph (the desktop mirror). */
export function WidgetGlyph({
  el,
  status,
  glyph,
  className = '',
}: {
  el: WidgetElement
  /** the status to show (widgets with a live status) */
  status?: ShownStatus | 'off'
  glyph?: (p: { className?: string }) => JSX.Element
  className?: string
}) {
  const brand = useBrand(el)
  const Icon = glyph ?? KIND_ICON[el.kind]
  if (status !== undefined) return <StatusGlyph status={status} icon={<Icon />} brand={brand} className={className} />
  if (brand)
    return (
      <span className={`status-icon status-icon--brand ${className}`}>
        <span className="status-icon__brand">{brand}</span>
      </span>
    )
  return (
    <span className={className}>
      <Icon />
    </span>
  )
}

// Now playing: three level bars that bob while music plays, the kind icon
// otherwise. Same rule as the spinner: motion only while something's going on.
const LEVELS = (
  <svg viewBox="0 0 16 16">
    <rect x="2" y="2.5" width="3" height="11" rx="1" className="np-levels__bar" />
    <rect x="6.5" y="2.5" width="3" height="11" rx="1" className="np-levels__bar" />
    <rect x="11" y="2.5" width="3" height="11" rx="1" className="np-levels__bar" />
  </svg>
)
export function NowPlayingGlyph({ className = '', brand }: { className?: string; brand?: React.ReactNode }) {
  const playing = useNowPlaying((s) => s.np.kind === 'track' && s.np.track.playing)
  // the player's own app icon, with the levels bobbing on it while it plays
  if (brand)
    return (
      <span className={`status-icon status-icon--brand np-glyph${playing ? ' np-glyph--playing' : ''} ${className}`} title={playing ? 'playing' : undefined}>
        <span className="status-icon__brand">{brand}</span>
        {playing && <span className="status-icon__badge np-glyph__badge">{LEVELS}</span>}
      </span>
    )
  return (
    <span className={`status-icon np-glyph${playing ? ' np-glyph--playing' : ''} ${className}`} title={playing ? 'playing' : undefined}>
      {playing ? LEVELS : <IconMusic />}
    </span>
  )
}

/** The icon slot for any widget: its live status where it has one, else its kind icon. */
export function WidgetSlotIcon({ el }: { el: WidgetElement }) {
  const brand = useBrand(el)
  const status = useDisplayStatus(el.id)
  if (showsStatus(el)) {
    const Icon = KIND_ICON[el.kind]
    return <StatusGlyph status={status} icon={<Icon />} brand={brand} />
  }
  if (el.kind === 'nowplaying') return <NowPlayingGlyph brand={brand} />
  if (brand)
    return (
      <span className="status-icon status-icon--brand">
        <span className="status-icon__brand">{brand}</span>
      </span>
    )
  const Icon = KIND_ICON[el.kind]
  return <Icon />
}
