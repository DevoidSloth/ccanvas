import { describe, expect, it } from 'vitest'
import { appOnlySite, hostOf, resolveAddress, searchQuery, searchUrl, isLocalUrl, looksLikeLocalFile, looksLikeUrl, normalizeUrl, parseStart, videoEmbed } from './weburl'

describe('normalizeUrl', () => {
  it('adds the right scheme', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('localhost:3000/a')).toBe('http://localhost:3000/a')
    expect(normalizeUrl('5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('10.0.0.2:8080')).toBe('http://10.0.0.2:8080')
    expect(normalizeUrl(' http://x.dev ')).toBe('http://x.dev')
    expect(normalizeUrl('')).toBe('')
  })
  it('keeps local addresses on http whatever follows the host', () => {
    expect(normalizeUrl('localhost:3000?x=1')).toBe('http://localhost:3000?x=1')
    expect(normalizeUrl('localhost:5173#a')).toBe('http://localhost:5173#a')
    expect(normalizeUrl('3000?x')).toBe('http://localhost:3000?x')
    expect(normalizeUrl('[::1]:8080')).toBe('http://[::1]:8080')
  })
})

describe('isLocalUrl', () => {
  it('spots dev servers and nothing else', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1')).toBe(true)
    expect(isLocalUrl('http://[::1]:3000/')).toBe(true)
    expect(isLocalUrl('https://example.com/')).toBe(false)
    expect(isLocalUrl('https://localhost.example.com/')).toBe(false)
  })
})

describe('looksLikeUrl', () => {
  it('takes addresses, not commands', () => {
    expect(looksLikeUrl('example.com')).toBe(true)
    expect(looksLikeUrl('docs.example.org/guide')).toBe(true)
    expect(looksLikeUrl('localhost:5173')).toBe(true)
    expect(looksLikeUrl('https://a.b')).toBe(true)
    expect(looksLikeUrl('new terminal')).toBe(false)
    expect(looksLikeUrl('save')).toBe(false)
    expect(looksLikeUrl('v1.2')).toBe(false)
  })
})

describe('looksLikeLocalFile', () => {
  it('takes html files and absolute paths', () => {
    expect(looksLikeLocalFile('dist/index.html')).toBe(true)
    expect(looksLikeLocalFile('/tmp/page')).toBe(true)
    expect(looksLikeLocalFile('https://example.com/index.html')).toBe(false)
    expect(looksLikeLocalFile('example.com')).toBe(false)
    expect(looksLikeLocalFile('localhost:8080/index.html')).toBe(false)
    expect(looksLikeLocalFile('example.com/about.html')).toBe(false)
    expect(looksLikeLocalFile('./index.html')).toBe(true)
    expect(looksLikeLocalFile('index.html')).toBe(true)
  })
})

it('hostOf falls back to the input', () => {
  expect(hostOf('https://example.com:8443/x')).toBe('example.com:8443')
  expect(hostOf('not a url')).toBe('not a url')
})

describe('videoEmbed', () => {
  const id = 'dQw4w9WgXcQ'
  const embed = `https://www.youtube.com/embed/${id}`
  it('turns YouTube video links into the player', () => {
    expect(videoEmbed(`https://www.youtube.com/watch?v=${id}`)).toBe(embed)
    expect(videoEmbed(`https://youtube.com/watch?feature=share&v=${id}`)).toBe(embed)
    expect(videoEmbed(`https://m.youtube.com/watch?v=${id}`)).toBe(embed)
    expect(videoEmbed(`https://music.youtube.com/watch?v=${id}`)).toBe(embed)
    expect(videoEmbed(`https://youtu.be/${id}?si=abc`)).toBe(embed)
    expect(videoEmbed(`https://www.youtube.com/shorts/${id}`)).toBe(embed)
    expect(videoEmbed(`https://www.youtube.com/live/${id}`)).toBe(embed)
    expect(videoEmbed(`https://www.youtube-nocookie.com/embed/${id}`)).toBe(embed)
  })
  it('keeps the start time and playlist', () => {
    expect(videoEmbed(`https://youtu.be/${id}?t=42`)).toBe(`${embed}?start=42`)
    expect(videoEmbed(`https://www.youtube.com/watch?v=${id}&t=1m30s`)).toBe(`${embed}?start=90`)
    expect(videoEmbed(`https://www.youtube.com/watch?v=${id}&list=PLabcdefghij`)).toBe(
      `${embed}?list=PLabcdefghij`,
    )
    expect(videoEmbed('https://www.youtube.com/playlist?list=PLabcdefghij')).toBe(
      'https://www.youtube.com/embed/videoseries?list=PLabcdefghij',
    )
  })
  it('handles Vimeo', () => {
    expect(videoEmbed('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(videoEmbed('https://vimeo.com/76979871/abc123def0')).toBe(
      'https://player.vimeo.com/video/76979871?h=abc123def0',
    )
  })
  it('leaves everything else alone', () => {
    expect(videoEmbed('https://www.youtube.com/')).toBeNull()
    expect(videoEmbed('https://www.youtube.com/results?search_query=x')).toBeNull()
    expect(videoEmbed('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(videoEmbed(`https://www.youtube.com/watch?v=${id}"><script>`)).toBeNull()
    expect(videoEmbed(`https://notyoutube.com/watch?v=${id}`)).toBeNull()
    expect(videoEmbed(`https://youtube.com.evil.test/watch?v=${id}`)).toBeNull()
    expect(videoEmbed('https://vimeo.com/channels/staffpicks')).toBeNull()
    expect(videoEmbed('https://example.com/')).toBeNull()
    expect(videoEmbed('not a url')).toBeNull()
  })
})

it('parseStart reads YouTube times', () => {
  expect(parseStart('90')).toBe(90)
  expect(parseStart('90s')).toBe(90)
  expect(parseStart('1h2m3s')).toBe(3723)
  expect(parseStart('2m')).toBe(120)
  expect(parseStart('')).toBe(0)
  expect(parseStart('soon')).toBe(0)
  expect(parseStart(null)).toBe(0)
})

describe('appOnlySite', () => {
  it('names YouTube pages that are not videos', () => {
    expect(appOnlySite('https://www.youtube.com/')).toBe('YouTube')
    expect(appOnlySite('https://youtube.com/@somechannel')).toBe('YouTube')
    expect(appOnlySite('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(appOnlySite('https://example.com/')).toBeNull()
  })
})

describe('resolveAddress', () => {
  const url = (v: string) => {
    const a = resolveAddress(v)
    return a?.kind === 'url' ? a.url : a
  }
  it('keeps addresses as addresses', () => {
    expect(url('localhost:3000')).toBe('http://localhost:3000')
    expect(url('localhost')).toBe('http://localhost')
    expect(url('3000')).toBe('http://localhost:3000')
    expect(url('example.com')).toBe('https://example.com')
    expect(url('docs.example.org/guide?x=1')).toBe('https://docs.example.org/guide?x=1')
    expect(url('10.0.0.2')).toBe('http://10.0.0.2')
    expect(url('192.168.1.4:8080/a')).toBe('http://192.168.1.4:8080/a')
    expect(url('https://a.b/c d')).toBe('https://a.b/c d')
    expect(url('devbox:8080')).toBe('http://devbox:8080')
  })
  it('opens local html files', () => {
    expect(resolveAddress('./index.html')).toEqual({ kind: 'file', path: './index.html' })
    expect(resolveAddress('/tmp/page.html')).toEqual({ kind: 'file', path: '/tmp/page.html' })
    expect(resolveAddress('dist/index.html')).toEqual({ kind: 'file', path: 'dist/index.html' })
  })
  it('searches for anything else', () => {
    expect(resolveAddress('how do flexbox gaps work')).toEqual({
      kind: 'url',
      url: 'https://www.google.com/search?q=how%20do%20flexbox%20gaps%20work',
      search: 'how do flexbox gaps work',
    })
    expect(url('react')).toBe(searchUrl('react'))
    expect(url('v1.2')).toBe(searchUrl('v1.2'))
    expect(url('what is example.com')).toBe(searchUrl('what is example.com'))
    expect(url('c++ & rust?')).toBe('https://www.google.com/search?q=c%2B%2B%20%26%20rust%3F')
    expect(resolveAddress('   ')).toBeNull()
  })
  it('reads a search back', () => {
    expect(searchQuery(searchUrl('a b'))).toBe('a b')
    expect(searchQuery('https://example.com/search?q=x')).toBeNull()
  })
})

it('sends searches to the real browser', () => {
  expect(appOnlySite(searchUrl('a b'))).toBe('Google Search')
  expect(appOnlySite('https://www.google.com/')).toBeNull()
})
