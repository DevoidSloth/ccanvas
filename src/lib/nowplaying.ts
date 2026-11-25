// Now playing: what the Spotify or Music app is playing, read over AppleScript.
//
// macOS only, desktop app only. Each poll runs one short `osascript` through
// runCommand(). That costs about 4 ms of CPU and an eighth of a second of wall
// time, so a long-lived JXA process (and the streaming plumbing it would need
// on the Rust side) isn't worth it.
//
// Polling. One poll loop is shared by every Now playing widget and runs only
// while at least one of them is on screen and the window isn't hidden: about
// once a second while something plays, every few seconds while paused. A poll
// only touches the store when something you'd see changed (the position counts
// only when it drifts from where it should be by now), so a widget doesn't
// re-render every second; the progress line moves on its own with a WAAPI
// animation, and the elapsed time is written straight into its text node.
//
// Controls. A click updates the store at once (optimistic) and sends the
// command; the poll after it confirms or corrects. A poll that was already on
// its way when the command went out read the app from before it, so its answer
// would undo the click: every command bumps a generation number before and
// after it runs, and a poll whose generation is no longer current is thrown
// away and re-run shortly instead. Seeking and volume drags send only their
// latest value, one command at a time.
//
// Every script checks `application "…" is running` before it talks to an app,
// because a `tell` would launch it. Nothing here is logged or saved: track
// details live only in this in-memory store, never in the .ccnvs file.

import { create } from 'zustand'
import { isTauri, mediaUrl, runCommand } from './backend'

export type Source = 'spotify' | 'music'
export const SOURCES: Source[] = ['spotify', 'music']
export const SOURCE_LABEL: Record<Source, string> = { spotify: 'Spotify', music: 'Music' }
const APP_NAME: Record<Source, string> = { spotify: 'Spotify', music: 'Music' }

export type Repeat = 'off' | 'all' | 'one'

export type Track = {
  source: Source
  playing: boolean
  title: string
  artist: string
  album: string
  durationMs: number
  /** position when it was read, at `at` (performance.now()) */
  positionMs: number
  at: number
  /** the app's id for the track (Spotify URI, Music persistent ID) */
  id: string
  /** an <img> src: Spotify's artwork URL, or Music's artwork file via the asset protocol */
  artwork: string | null
  /** the app's own volume, 0–100 */
  volume: number
  /** Music's mute; Spotify has none, so there it means volume 0 */
  muted: boolean
  shuffle: boolean
  /** Spotify only knows off and all */
  repeat: Repeat
  /** Music's favourite; null where the app has none (Spotify's `starred` is never readable) */
  liked: boolean | null
}

export type NowPlaying =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'idle' }
  /** the user said no to "ccanvas wants to control …" */
  | { kind: 'denied'; source: Source }
  | { kind: 'track'; track: Track }

/** Can this build read Now playing at all? (the macOS desktop app) */
export function nowPlayingSupported(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
}

export const useNowPlaying = create<{
  np: NowPlaying
  /** other apps with a track you could switch to */
  others: Source[]
}>(() => ({
  np: nowPlayingSupported() ? { kind: 'loading' } : { kind: 'unsupported' },
  others: [],
}))

/** Where the track is now, moving on from the last poll while it plays. */
export function positionNow(t: Track, now = performance.now()): number {
  if (!t.playing) return t.positionMs
  const p = t.positionMs + (now - t.at)
  return t.durationMs > 0 ? Math.min(p, t.durationMs) : p
}

/** 0:07, 3:45, 1:02:03 */
export function formatTime(ms: number): string {
  if (!(ms > 0)) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

// ---------- the scripts ----------

// Fields are split by the unit separator, sources by the record separator:
// neither turns up in track names.
const US = '\u001f'
const RS = '\u001e'

// Each part adds one record to `out`:
//   <source> <state> [<title> <artist> <album> <duration ms> <position ms> <id>
//   <artwork> <volume> <muted> <shuffle> <repeat> <liked>]
// Values are read inside the `tell` and joined outside it, so the number
// coercions and file writes are ours, not sent to the app. The player settings
// are read one by one in their own `try`, so an app version without one still
// shows the track. Error -1743 is "not authorised to send Apple events" (the
// user declined the prompt).
const PART: Record<Source, string> = {
  spotify: `
if application "Spotify" is running then
	try
		set vol to -1
		set shuf to ""
		set rpt to ""
		with timeout of 4 seconds
			tell application "Spotify"
				set s to player state as text
				if s is not "stopped" then
					set t to current track
					set nm to name of t
					set ar to artist of t
					set al to album of t
					set du to duration of t
					set pp to player position
					set tid to id of t
					set aw to artwork url of t
					try
						set vol to sound volume
					end try
					try
						set shuf to shuffling
					end try
					try
						set rpt to repeating
					end try
				end if
			end tell
		end timeout
		if s is "stopped" then
			set end of out to "spotify" & US & s
		else
			set end of out to "spotify" & US & s & US & nm & US & ar & US & al & US & ((du as real) as integer) & US & ((pp * 1000) as integer) & US & tid & US & aw & US & vol & US & "" & US & shuf & US & rpt & US & ""
		end if
	on error number n
		if n is -1743 then set end of out to "spotify" & US & "denied"
	end try
end if`,
  // «class pLov» is the track's favourite flag: `favorited` in today's Music,
  // `loved` in older ones. The raw code compiles on both.
  music: `
if application "Music" is running then
	try
		set raw to missing value
		set vol to -1
		set mu to ""
		set shuf to ""
		set rpt to ""
		set fav to ""
		with timeout of 4 seconds
			tell application "Music"
				set s to player state as text
				if s is not "stopped" then
					set t to current track
					set nm to name of t
					set ar to artist of t
					set al to album of t
					set du to 0
					try
						set du to duration of t
					end try
					set pp to player position
					set tid to persistent ID of t
					if tid is not knownMusic and (count of artworks of t) > 0 then
						set a to artwork 1 of t
						set fmt to (format of a) as text
						set raw to raw data of a
					end if
					try
						set vol to sound volume
					end try
					try
						set mu to mute
					end try
					try
						set shuf to shuffle enabled
					end try
					try
						set rpt to song repeat as text
					end try
					try
						set fav to «class pLov» of t
					end try
				end if
			end tell
		end timeout
		if s is "stopped" then
			set end of out to "music" & US & s
		else
			set art to ""
			if tid is knownMusic then
				set art to "="
			else if raw is not missing value then
				set dir to POSIX path of (path to temporary items from user domain)
				do shell script "rm -f " & quoted form of dir & "ccanvas-artwork-*"
				set ext to ".jpg"
				if fmt contains "PNG" then set ext to ".png"
				set art to dir & "ccanvas-artwork-" & tid & ext
				try
					set f to open for access (POSIX file art) with write permission
					set eof f to 0
					write raw to f
					close access f
				on error
					try
						close access (POSIX file art)
					end try
					set art to ""
				end try
			end if
			set end of out to "music" & US & s & US & nm & US & ar & US & al & US & ((du * 1000) as integer) & US & ((pp * 1000) as integer) & US & tid & US & art & US & vol & US & mu & US & shuf & US & rpt & US & fav
		end if
	on error number n
		if n is -1743 then set end of out to "music" & US & "denied"
	end try
end if`,
}

/** One osascript program that reads the given sources. argv 1 is the Music
 *  track whose artwork is already on disk (so it isn't written again). */
export function buildScript(sources: Source[]): string {
  return [
    'on run argv',
    'set US to character id 31',
    'set RS to character id 30',
    'set knownMusic to ""',
    'if (count of argv) > 0 then set knownMusic to item 1 of argv',
    'set out to {}',
    ...sources.map((s) => PART[s]),
    "set AppleScript's text item delimiters to RS",
    'return out as text',
    'end run',
  ].join('\n')
}

/** One app's answer, as parsed from the script's output. */
export type Sample = { source: Source; state: 'stopped' | 'denied' } | TrackSample
export type TrackSample = {
  source: Source
  state: 'playing' | 'paused'
  title: string
  artist: string
  album: string
  durationMs: number
  positionMs: number
  id: string
  /** a URL or path; '' for none; '=' for "the one you already have" */
  art: string
  /** -1 when the app didn't say */
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: Repeat
  liked: boolean | null
}

const clean = (s: string | undefined): string => (!s || s === 'missing value' ? '' : s)
// AppleScript writes numbers in the user's locale ("1,5") and may use exponents
const num = (s: string | undefined): number => {
  const n = parseFloat(clean(s).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}
const bool = (s: string | undefined) => clean(s) === 'true'
// Spotify's `repeating` is a boolean, Music's `song repeat` is off/one/all
const repeatOf = (s: string | undefined): Repeat => {
  const v = clean(s)
  return v === 'true' || v === 'all' ? 'all' : v === 'one' ? 'one' : 'off'
}

export function parseOutput(stdout: string): Sample[] {
  const out: Sample[] = []
  for (const rec of stdout.replace(/\n$/, '').split(RS)) {
    const f = rec.split(US)
    const source = f[0] as Source
    if (!SOURCES.includes(source)) continue
    const st = f[1] ?? ''
    if (st === 'stopped' || st === 'denied') {
      out.push({ source, state: st })
      continue
    }
    // Music's "fast forwarding" and "rewinding" count as playing
    const state = st === 'paused' ? 'paused' : st ? 'playing' : null
    if (!state) continue
    const vol = clean(f[9])
    const volume = vol === '' || vol.startsWith('-') ? -1 : Math.min(100, Math.round(num(vol)))
    out.push({
      source,
      state,
      title: clean(f[2]),
      artist: clean(f[3]),
      album: clean(f[4]),
      durationMs: num(f[5]),
      positionMs: num(f[6]),
      id: clean(f[7]),
      art: clean(f[8]),
      volume,
      muted: bool(f[10]),
      shuffle: bool(f[11]),
      repeat: repeatOf(f[12]),
      liked: clean(f[13]) === '' ? null : bool(f[13]),
    })
  }
  return out
}

const hasTrack = (s: Sample): s is TrackSample => s.state === 'playing' || s.state === 'paused'

/** Which app to show: the one you picked while it has a track, else a playing
 *  one beats a paused one, Spotify first. */
export function pickSample(samples: Sample[], prefer: Source | null = null): Sample | null {
  if (prefer) {
    const p = samples.find((s) => s.source === prefer && hasTrack(s))
    if (p) return p
  }
  const order = (s: Sample) => SOURCES.indexOf(s.source)
  const by = (state: Sample['state']) =>
    samples.filter((s) => s.state === state).sort((a, b) => order(a) - order(b))[0]
  return by('playing') ?? by('paused') ?? by('denied') ?? null
}

/** How far the read position may stray from the interpolated one before it's
 *  worth re-anchoring the progress line (a seek in the app, a stall). */
const DRIFT_MS = 1200

/** Would showing `next` in place of `prev` change anything you can see? */
export function sameTrack(prev: Track, next: Track): boolean {
  return (
    prev.source === next.source &&
    prev.playing === next.playing &&
    prev.id === next.id &&
    prev.title === next.title &&
    prev.artist === next.artist &&
    prev.album === next.album &&
    prev.durationMs === next.durationMs &&
    prev.artwork === next.artwork &&
    prev.volume === next.volume &&
    prev.muted === next.muted &&
    prev.shuffle === next.shuffle &&
    prev.repeat === next.repeat &&
    prev.liked === next.liked &&
    Math.abs(positionNow(prev, next.at) - next.positionMs) < DRIFT_MS
  )
}

export function sameNowPlaying(a: NowPlaying, b: NowPlaying): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'track' && b.kind === 'track') return sameTrack(a.track, b.track)
  if (a.kind === 'denied' && b.kind === 'denied') return a.source === b.source
  return true
}

/** Commands and polls race; see the top of the file. A poll remembers the
 *  generation it started in and keeps its answer only if it's still current. */
export function createGuard() {
  let gen = 0
  return {
    /** a poll starts */
    begin: () => gen,
    /** a command is about to run, or has just run */
    bump: () => {
      gen++
    },
    /** may a poll that began at `g` show its answer? */
    fresh: (g: number) => g === gen,
  }
}

// ---------- polling ----------

/** Sources whose script compiles here (Spotify's won't if it isn't installed). */
let sources: Source[] = [...SOURCES]
/** Music artwork on disk: the track it belongs to and its <img> src. */
let musicArt: { id: string; src: string | null } = { id: '', src: null }
/** the app you picked to show while both have a track (in memory only) */
let prefer: Source | null = null
/** the last poll's answers, so switching apps doesn't wait for the next one */
let lastSamples: Sample[] = []
let lastAt = 0
const demand = new Map<string, boolean>()
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
const guard = createGuard()
/** after a command, how soon to read the app again */
const SOON = 300

const isCompileError = (stderr: string) => /syntax error|\(-27\d\d\)/i.test(stderr)

async function osa(script: string, args: string[] = []) {
  return runCommand('/usr/bin/osascript', ['-e', script, ...args])
}

/** Drop the sources whose script doesn't compile (an app that isn't installed). */
async function pruneSources() {
  const ok: Source[] = []
  for (const s of sources) {
    const r = await osa(buildScript([s]))
    if (r && !(r.code !== 0 && isCompileError(r.stderr))) ok.push(s)
  }
  sources = ok
}

async function read(): Promise<Sample[]> {
  if (!sources.length) return []
  let r = await osa(buildScript(sources), [musicArt.id])
  if (r && r.code !== 0 && isCompileError(r.stderr)) {
    await pruneSources()
    if (!sources.length) return []
    r = await osa(buildScript(sources), [musicArt.id])
  }
  if (!r || r.code !== 0) return []
  return parseOutput(r.stdout)
}

function toTrack(s: TrackSample, at: number): Track {
  let artwork: string | null
  if (s.source === 'music') {
    if (s.art !== '=') musicArt = { id: s.id, src: s.art ? mediaUrl(s.art) : null }
    artwork = musicArt.id === s.id ? musicArt.src : null
  } else {
    artwork = /^https?:\/\//.test(s.art) ? s.art : null
  }
  const volume = s.volume < 0 ? 100 : s.volume
  return {
    source: s.source,
    playing: s.state === 'playing',
    title: s.title,
    artist: s.artist,
    album: s.album,
    durationMs: s.durationMs,
    positionMs: s.positionMs,
    at,
    id: s.id,
    artwork,
    volume,
    muted: s.source === 'spotify' ? volume === 0 : s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    liked: s.source === 'music' ? s.liked : null,
  }
}

/** Put the last answers on screen, touching the store only for a real change. */
function show(samples: Sample[], at: number) {
  const s = pickSample(samples, prefer)
  const np: NowPlaying =
    !s || s.state === 'stopped'
      ? { kind: 'idle' }
      : s.state === 'denied'
        ? { kind: 'denied', source: s.source }
        : { kind: 'track', track: toTrack(s as TrackSample, at) }
  const shown = np.kind === 'track' ? np.track.source : null
  const others = samples.filter((x) => hasTrack(x) && x.source !== shown).map((x) => x.source)
  const cur = useNowPlaying.getState()
  const patch: Partial<ReturnType<typeof useNowPlaying.getState>> = {}
  if (!sameNowPlaying(cur.np, np)) patch.np = np
  if (cur.others.join() !== others.join()) patch.others = others
  if (patch.np || patch.others) useNowPlaying.setState(patch)
}

const wanted = () =>
  nowPlayingSupported() && !document.hidden && [...demand.values()].some(Boolean)

function schedule(delay?: number) {
  if (timer) clearTimeout(timer)
  timer = null
  if (!wanted()) return
  const np = useNowPlaying.getState().np
  const playing = np.kind === 'track' && np.track.playing
  timer = setTimeout(tick, delay ?? (playing ? 1000 : 3000))
}

async function tick() {
  timer = null
  if (inFlight || !wanted()) return
  inFlight = true
  const g = guard.begin()
  let stale = false
  try {
    const t0 = performance.now()
    const samples = await read()
    const at = (t0 + performance.now()) / 2
    stale = !guard.fresh(g)
    if (!stale) {
      // you picked a paused app and another one starts playing: follow it
      if (prefer) {
        const mine = samples.find((s) => s.source === prefer)
        const wasPlaying = (src: Source) => lastSamples.some((s) => s.source === src && s.state === 'playing')
        const started = samples.find((s) => s.source !== prefer && s.state === 'playing' && !wasPlaying(s.source))
        if (!mine || !hasTrack(mine) || (mine.state === 'paused' && started)) prefer = null
      }
      lastSamples = samples
      lastAt = at
      show(samples, at)
    }
  } finally {
    inFlight = false
  }
  // a command went out while this poll ran: read again soon, not in a second
  schedule(stale ? SOON : undefined)
}

let listening = false
function listen() {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('visibilitychange', () => schedule(document.hidden ? undefined : 0))
}

/** A Now playing widget says whether it's on screen. The first visible one
 *  starts polling straight away; when none is, polling stops. */
export function setNowPlayingDemand(id: string, visible: boolean) {
  listen()
  const before = wanted()
  demand.set(id, visible)
  if (!before && wanted()) schedule(0)
}
export function dropNowPlayingDemand(id: string) {
  demand.delete(id)
  if (!wanted()) schedule()
}

/** Show this app's track while both have one. */
export function showSource(source: Source) {
  prefer = source
  show(lastSamples, lastAt)
}

// ---------- controls ----------

export type Command =
  | { do: 'playpause' }
  | { do: 'next' }
  | { do: 'previous' }
  | { do: 'seek'; ms: number }
  | { do: 'volume'; value: number }
  | { do: 'mute'; on: boolean }
  | { do: 'shuffle'; on: boolean }
  | { do: 'repeat'; mode: Repeat }
  | { do: 'like'; on: boolean }

/** The AppleScript statement for a command, or null where the app has none. */
function verb(source: Source, c: Command): string | null {
  const spotify = source === 'spotify'
  switch (c.do) {
    case 'playpause':
      return 'playpause'
    case 'next':
      return 'next track'
    case 'previous':
      // Music's `back track` is its button: back to the start, or the track
      // before when already there
      return spotify ? 'previous track' : 'back track'
    case 'seek':
      return `set player position to ${(Math.max(0, c.ms) / 1000).toFixed(2)}`
    case 'volume': {
      const v = Math.round(Math.min(100, Math.max(0, c.value)))
      // Spotify lands one below whatever it's sent (except 0 and 100)
      return `set sound volume to ${spotify && v > 0 ? Math.min(100, v + 1) : v}`
    }
    case 'mute':
      return spotify ? null : `set mute to ${c.on}`
    case 'shuffle':
      return spotify ? `set shuffling to ${c.on}` : `set shuffle enabled to ${c.on}`
    case 'repeat':
      return spotify ? `set repeating to ${c.mode !== 'off'}` : `set song repeat to ${c.mode}`
    case 'like':
      return spotify ? null : `set «class pLov» of current track to ${c.on}`
  }
}

/** A one-line script for a command that does nothing if the app isn't running. */
export function commandScript(source: Source, c: Command): string | null {
  const v = verb(source, c)
  const app = APP_NAME[source]
  return v && `if application "${app}" is running then tell application "${app}" to ${v}`
}

/** What a command does to the track on screen, before the app confirms it. */
export function applyCommand(t: Track, c: Command, now: number): Track {
  switch (c.do) {
    case 'playpause':
      return { ...t, playing: !t.playing, positionMs: positionNow(t, now), at: now }
    case 'seek': {
      const ms = Math.max(0, t.durationMs > 0 ? Math.min(c.ms, t.durationMs) : c.ms)
      return { ...t, positionMs: ms, at: now }
    }
    case 'volume': {
      const v = Math.round(Math.min(100, Math.max(0, c.value)))
      return { ...t, volume: v, muted: t.source === 'spotify' ? v === 0 : v === 0 ? t.muted : false }
    }
    case 'mute':
      return { ...t, muted: c.on }
    case 'shuffle':
      return { ...t, shuffle: c.on }
    case 'repeat':
      return { ...t, repeat: c.mode }
    case 'like':
      return t.liked === null ? t : { ...t, liked: c.on }
    default:
      return t
  }
}

/** The next repeat mode on a click: Spotify has no "repeat one". */
export function nextRepeat(source: Source, r: Repeat): Repeat {
  if (source === 'spotify') return r === 'off' ? 'all' : 'off'
  return r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'
}

// Seeks and volume drags send only their latest value, one at a time.
const latest = new Map<string, { script: string | null; busy: boolean }>()

async function run(script: string, coalesce?: string) {
  if (coalesce) {
    let q = latest.get(coalesce)
    if (!q) latest.set(coalesce, (q = { script: null, busy: false }))
    q.script = script
    if (q.busy) return
    q.busy = true
    try {
      while (q.script) {
        const s = q.script
        q.script = null
        guard.bump()
        await osa(s)
        guard.bump()
      }
    } finally {
      q.busy = false
    }
  } else {
    guard.bump()
    await osa(script)
    guard.bump()
  }
  schedule(SOON)
}

/** Spotify has no mute: muting sets its volume to 0 and remembers this. */
let unmuteTo = 50

/** Send a command to the app being shown. Never launches it. */
export async function control(source: Source, c: Command) {
  const np = useNowPlaying.getState().np
  const t = np.kind === 'track' && np.track.source === source ? np.track : null
  if (source === 'spotify' && c.do === 'mute') {
    if (c.on && t && t.volume > 0) unmuteTo = t.volume
    return control(source, { do: 'volume', value: c.on ? 0 : unmuteTo || 50 })
  }
  // Music: moving the volume off 0 unmutes it too
  if (source === 'music' && c.do === 'volume' && c.value > 0 && t?.muted) void control(source, { do: 'mute', on: false })
  const script = commandScript(source, c)
  if (!script) return
  if (t) {
    const next = applyCommand(t, c, performance.now())
    if (next !== t) useNowPlaying.setState({ np: { kind: 'track', track: next } })
  }
  const coalesce = c.do === 'seek' || c.do === 'volume' ? `${source}:${c.do}` : undefined
  await run(script, coalesce)
}

// ---------- artwork tint ----------

/** A soft colour for the widget's wash from an artwork's pixels (RGBA): the
 *  hue with the most colourful pixels (a histogram, so blue and yellow don't
 *  average to green), evened out so it reads on the dark panel. null for
 *  artwork with no colour to speak of. */
export function tintOf(px: ArrayLike<number>): string | null {
  const BINS = 12
  const weight = new Array<number>(BINS).fill(0)
  const sat = new Array<number>(BINS).fill(0)
  const hx = new Array<number>(BINS).fill(0)
  const hy = new Array<number>(BINS).fill(0)
  let n = 0
  for (let i = 0; i + 3 < px.length; i += 4) {
    n++
    const r = px[i] / 255
    const g = px[i + 1] / 255
    const b = px[i + 2] / 255
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    if (d < 0.08) continue // grey
    const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6
    const w = d * max
    const k = Math.floor(h * BINS) % BINS
    weight[k] += w
    sat[k] += (d / (1 - Math.abs(max + max - d - 1) || 1)) * w
    hx[k] += Math.cos(h * 2 * Math.PI) * w
    hy[k] += Math.sin(h * 2 * Math.PI) * w
  }
  let best = 0
  for (let k = 1; k < BINS; k++) if (weight[k] > weight[best]) best = k
  // too little colour overall: no tint
  if (!n || weight[best] / n < 0.04) return null
  const hue = ((Math.atan2(hy[best], hx[best]) / (2 * Math.PI)) * 360 + 360) % 360
  const s = Math.min(0.62, Math.max(0.28, sat[best] / weight[best]))
  return `hsl(${Math.round(hue)} ${Math.round(s * 100)}% 58%)`
}
