import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  buildScript,
  commandScript,
  createGuard,
  formatTime,
  nextRepeat,
  parseOutput,
  pickSample,
  positionNow,
  sameNowPlaying,
  sameTrack,
  tintOf,
  type Command,
  type Repeat,
  type Track,
} from './nowplaying'

const US = '\u001f'
const RS = '\u001e'
const rec = (...f: string[]) => f.join(US)

describe('parseOutput', () => {
  it('reads a Spotify track (duration in ms, artwork URL)', () => {
    const out = rec('spotify', 'paused', 'Sentimental', 'B.U.G Antman', "Y'all Ugly", '151741', '0', 'spotify:track:5k8p', 'https://i.scdn.co/image/x') + '\n'
    expect(parseOutput(out)).toEqual([
      {
        source: 'spotify',
        state: 'paused',
        title: 'Sentimental',
        artist: 'B.U.G Antman',
        album: "Y'all Ugly",
        durationMs: 151741,
        positionMs: 0,
        id: 'spotify:track:5k8p',
        art: 'https://i.scdn.co/image/x',
        volume: -1,
        muted: false,
        shuffle: false,
        repeat: 'off',
        liked: null,
      },
    ])
  })

  it('reads both apps, stopped and denied states, and locale numbers', () => {
    const out = [
      rec('spotify', 'denied'),
      rec('music', 'fast forwarding', 'Song', 'missing value', '', '245300', '1,5E+4', 'ABC', '='),
    ].join(RS)
    const [sp, mu] = parseOutput(out)
    expect(sp).toEqual({ source: 'spotify', state: 'denied' })
    expect(mu).toMatchObject({ state: 'playing', artist: '', durationMs: 245300, positionMs: 15000, art: '=' })
    expect(parseOutput(rec('music', 'stopped'))).toEqual([{ source: 'music', state: 'stopped' }])
  })

  it('is empty when nothing runs, and skips junk', () => {
    expect(parseOutput('')).toEqual([])
    expect(parseOutput('\n')).toEqual([])
    expect(parseOutput(rec('winamp', 'playing', 'x'))).toEqual([])
  })
})

describe('pickSample', () => {
  const s = (source: 'spotify' | 'music', state: 'playing' | 'paused') =>
    parseOutput(rec(source, state, 't', 'a', 'al', '1', '0', 'id', ''))[0]

  it('prefers a playing app, then Spotify', () => {
    expect(pickSample([s('spotify', 'paused'), s('music', 'playing')])?.source).toBe('music')
    expect(pickSample([s('music', 'playing'), s('spotify', 'playing')])?.source).toBe('spotify')
    expect(pickSample([s('music', 'paused'), s('spotify', 'paused')])?.source).toBe('spotify')
  })

  it('reports a refusal only when nothing else is there', () => {
    const denied = parseOutput(rec('spotify', 'denied'))
    expect(pickSample(denied)?.state).toBe('denied')
    expect(pickSample([...denied, s('music', 'paused')])?.source).toBe('music')
    expect(pickSample(parseOutput(rec('music', 'stopped')))).toBeNull()
    expect(pickSample([])).toBeNull()
  })
})

describe('buildScript', () => {
  it('checks each app is running before telling it anything', () => {
    for (const src of [['spotify'], ['music'], ['spotify', 'music']] as const) {
      const sc = buildScript([...src])
      for (const app of ['Spotify', 'Music']) {
        const tell = sc.indexOf(`tell application "${app}"`)
        if (tell < 0) continue
        expect(sc.indexOf(`if application "${app}" is running then`)).toBeGreaterThanOrEqual(0)
        expect(sc.indexOf(`if application "${app}" is running then`)).toBeLessThan(tell)
      }
    }
    expect(buildScript(['music'])).not.toContain('Spotify')
  })
})

describe('positionNow', () => {
  const t: Track = {
    source: 'spotify',
    playing: true,
    title: '',
    artist: '',
    album: '',
    durationMs: 10_000,
    positionMs: 4000,
    at: 1000,
    id: '',
    artwork: null,
    volume: 50,
    muted: false,
    shuffle: false,
    repeat: 'off',
    liked: null,
  }
  it('moves on while playing, stops at the end, holds while paused', () => {
    expect(positionNow(t, 2500)).toBe(5500)
    expect(positionNow(t, 99_000)).toBe(10_000)
    expect(positionNow({ ...t, playing: false }, 2500)).toBe(4000)
  })
})

describe('player settings', () => {
  it('reads volume, shuffle, repeat and Music’s favourite', () => {
    const sp = parseOutput(rec('spotify', 'playing', 't', 'a', 'al', '1000', '0', 'id', '', '23', '', 'true', 'true', ''))[0]
    expect(sp).toMatchObject({ volume: 23, muted: false, shuffle: true, repeat: 'all', liked: null })
    const mu = parseOutput(rec('music', 'paused', 't', 'a', 'al', '1000', '0', 'id', '', '60', 'true', 'false', 'one', 'true'))[0]
    expect(mu).toMatchObject({ volume: 60, muted: true, shuffle: false, repeat: 'one', liked: true })
  })

  it('copes with an app that didn’t say', () => {
    const old = parseOutput(rec('spotify', 'paused', 't', 'a', 'al', '1000', '0', 'id', 'https://x'))[0]
    expect(old).toMatchObject({ volume: -1, shuffle: false, repeat: 'off', liked: null })
    const none = parseOutput(rec('music', 'paused', 't', 'a', 'al', '1000', '0', 'id', '', '-1', '', '', '', ''))[0]
    expect(none).toMatchObject({ volume: -1, liked: null })
  })
})

describe('pickSample with a preference', () => {
  const s = (source: 'spotify' | 'music', state: 'playing' | 'paused') =>
    parseOutput(rec(source, state, 't', 'a', 'al', '1', '0', 'id', ''))[0]
  it('shows the app you picked while it has a track', () => {
    expect(pickSample([s('spotify', 'playing'), s('music', 'paused')], 'music')?.source).toBe('music')
    expect(pickSample([s('spotify', 'playing'), ...parseOutput(rec('music', 'stopped'))], 'music')?.source).toBe('spotify')
  })
})

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(-5)).toBe('0:00')
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(7_900)).toBe('0:07')
    expect(formatTime(225_000)).toBe('3:45')
    expect(formatTime(3_723_000)).toBe('1:02:03')
  })
})

const track = (over: Partial<Track> = {}): Track => ({
  source: 'spotify',
  playing: true,
  title: 'a',
  artist: 'b',
  album: 'c',
  durationMs: 200_000,
  positionMs: 10_000,
  at: 1000,
  id: 'x',
  artwork: null,
  volume: 50,
  muted: false,
  shuffle: false,
  repeat: 'off',
  liked: null,
  ...over,
})

describe('sameTrack', () => {
  it('ignores a position that moved on as expected', () => {
    expect(sameTrack(track(), track({ positionMs: 11_000, at: 2000 }))).toBe(true)
    expect(sameTrack(track(), track({ positionMs: 11_500, at: 2000 }))).toBe(true)
  })
  it('notices a seek, a pause and a setting', () => {
    expect(sameTrack(track(), track({ positionMs: 40_000, at: 2000 }))).toBe(false)
    expect(sameTrack(track(), track({ playing: false }))).toBe(false)
    expect(sameTrack(track(), track({ volume: 49 }))).toBe(false)
    expect(sameTrack(track(), track({ id: 'y' }))).toBe(false)
  })
  it('compares the other states', () => {
    expect(sameNowPlaying({ kind: 'idle' }, { kind: 'idle' })).toBe(true)
    expect(sameNowPlaying({ kind: 'denied', source: 'music' }, { kind: 'denied', source: 'spotify' })).toBe(false)
    expect(sameNowPlaying({ kind: 'idle' }, { kind: 'track', track: track() })).toBe(false)
  })
})

describe('createGuard (stale polls)', () => {
  it('drops a poll that a command overtook, keeps one that started after it', () => {
    const g = createGuard()
    const before = g.begin()
    g.bump() // the command goes out
    const during = g.begin() // a poll starts while the app is still handling it
    g.bump() // the command is done
    const after = g.begin()
    expect(g.fresh(before)).toBe(false)
    expect(g.fresh(during)).toBe(false)
    expect(g.fresh(after)).toBe(true)
  })
})

describe('commands', () => {
  it('never talks to an app that isn’t running', () => {
    const all: Command[] = [
      { do: 'playpause' }, { do: 'next' }, { do: 'previous' }, { do: 'seek', ms: 1000 },
      { do: 'volume', value: 40 }, { do: 'mute', on: true }, { do: 'shuffle', on: true },
      { do: 'repeat', mode: 'one' }, { do: 'like', on: true },
    ]
    for (const source of ['spotify', 'music'] as const)
      for (const c of all) {
        const s = commandScript(source, c)
        if (s) expect(s).toMatch(/^if application "(Spotify|Music)" is running then tell application "\1" to /)
      }
  })
  it('knows what each app can do', () => {
    expect(commandScript('spotify', { do: 'like', on: true })).toBeNull()
    expect(commandScript('spotify', { do: 'mute', on: true })).toBeNull()
    expect(commandScript('music', { do: 'like', on: true })).toContain('«class pLov» of current track to true')
    expect(commandScript('spotify', { do: 'repeat', mode: 'all' })).toContain('set repeating to true')
    expect(commandScript('music', { do: 'repeat', mode: 'one' })).toContain('set song repeat to one')
    expect(commandScript('music', { do: 'previous' })).toContain('back track')
  })
  it('sends Spotify one more than the volume wanted (it lands one below)', () => {
    expect(commandScript('spotify', { do: 'volume', value: 40 })).toContain('to 41')
    expect(commandScript('spotify', { do: 'volume', value: 0 })).toContain('to 0')
    expect(commandScript('spotify', { do: 'volume', value: 100 })).toContain('to 100')
    expect(commandScript('music', { do: 'volume', value: 40 })).toContain('to 40')
  })
  it('seeks in seconds, clamped', () => {
    expect(commandScript('spotify', { do: 'seek', ms: 61_500 })).toContain('set player position to 61.50')
    expect(commandScript('music', { do: 'seek', ms: -3 })).toContain('to 0.00')
  })
  it('applies a command to the track on screen at once', () => {
    const t = track()
    const p = applyCommand(t, { do: 'playpause' }, 3000)
    expect(p).toMatchObject({ playing: false, positionMs: 12_000, at: 3000 })
    expect(applyCommand(t, { do: 'seek', ms: 999_999 }, 3000)).toMatchObject({ positionMs: 200_000 })
    expect(applyCommand(t, { do: 'volume', value: 0 }, 0)).toMatchObject({ volume: 0, muted: true })
    expect(applyCommand(track({ source: 'music', muted: true }), { do: 'volume', value: 30 }, 0).muted).toBe(false)
    expect(applyCommand(t, { do: 'like', on: true }, 0)).toBe(t)
  })
  it('cycles repeat the way each app does', () => {
    expect(nextRepeat('spotify', 'off')).toBe('all')
    expect(nextRepeat('spotify', 'all')).toBe('off')
    expect(['off', 'all', 'one'].map((r) => nextRepeat('music', r as Repeat))).toEqual(['all', 'one', 'off'])
  })
})

describe('tintOf', () => {
  const px = (...rgb: [number, number, number][]) => rgb.flatMap(([r, g, b]) => [r, g, b, 255])
  it('finds the colour in an artwork, ignoring greys', () => {
    expect(tintOf(px([200, 40, 40], [30, 30, 30], [220, 220, 220]))).toMatch(/^hsl\(0 \d+% 58%\)$/)
    expect(tintOf(px([40, 60, 200], [40, 60, 200]))).toMatch(/^hsl\(23\d /)
  })
  it('takes the main hue rather than averaging two', () => {
    const blue = Array.from({ length: 9 }, () => [47, 122, 154] as [number, number, number])
    const yellow = Array.from({ length: 3 }, () => [224, 192, 64] as [number, number, number])
    const hue = Number(/hsl\((\d+)/.exec(tintOf(px(...blue, ...yellow)) ?? '')?.[1])
    expect(hue).toBeGreaterThan(185)
    expect(hue).toBeLessThan(205)
  })
  it('gives none for a grey or empty image', () => {
    expect(tintOf(px([128, 128, 128], [20, 20, 20]))).toBeNull()
    expect(tintOf([])).toBeNull()
  })
})
