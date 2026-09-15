// Claude-style welcome greeting: time-of-day aware, addressed to the user by
// name when we can find it, and varied so it doesn't repeat launch to launch.

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './backend'

export interface Greeting {
  title: string
  subtitle: string
}

const LAST_KEY = 'ccanvas.lastGreeting'

type Template = (name: string, day: string) => string

const BY_TIME: Record<'lateNight' | 'morning' | 'afternoon' | 'evening', Template[]> = {
  lateNight: [
    (n) => `Burning the midnight oil${n}?`,
    (n) => `Still up${n}?`,
    (n) => `Late one tonight${n}`,
    (n) => `The quiet hours${n}`,
  ],
  morning: [
    (n) => `Good morning${n}`,
    (n) => `Morning${n}`,
    (n) => `Coffee and code${n}?`,
    (n, d) => `Happy ${d} morning${n}`,
  ],
  afternoon: [
    (n) => `Good afternoon${n}`,
    (n) => `Afternoon${n}`,
    (n, d) => `${d} afternoon${n}`,
  ],
  evening: [
    (n) => `Good evening${n}`,
    (n) => `Evening${n}`,
    (n, d) => `${d} evening${n}`,
    (n) => `Winding down${n}, or just getting started?`,
  ],
}

const ANYTIME: Template[] = [
  (n) => `Welcome back${n}`,
  (n) => `Back at it${n}`,
  (n) => `Hey there${n}`,
  (n) => `What are we building${n}?`,
  (n) => `Good to see you${n}`,
  (n, d) => `How's your ${d}${n}?`,
]

const SUBTITLES = [
  'What should your agents work on?',
  'Pick up where you left off, or start something new.',
  'Point Claude at a project and let it get going.',
  'A clean canvas, ready when you are.',
  'Start an agent, open a terminal, see where it goes.',
  'Line up a few agents and let them get to work.',
]

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function timeBucket(h: number): keyof typeof BY_TIME {
  if (h < 5) return 'lateNight'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

export function makeGreeting(firstName: string | null, now = new Date()): Greeting {
  const n = firstName ? `, ${firstName}` : ''
  const day = now.toLocaleDateString(undefined, { weekday: 'long' })
  // mostly time-of-day greetings, sometimes a general one
  const pool = [...BY_TIME[timeBucket(now.getHours())], ...BY_TIME[timeBucket(now.getHours())], ...ANYTIME]

  let last = ''
  try {
    last = localStorage.getItem(LAST_KEY) ?? ''
  } catch {
    /* storage unavailable */
  }
  let title = pick(pool)(n, day)
  for (let i = 0; i < 6 && title === last; i++) title = pick(pool)(n, day)
  try {
    localStorage.setItem(LAST_KEY, title)
  } catch {
    /* storage unavailable */
  }
  return { title, subtitle: pick(SUBTITLES) }
}

let namePromise: Promise<string | null> | null = null
export function loadFirstName(): Promise<string | null> {
  if (!namePromise)
    namePromise = isTauri()
      ? invoke<string | null>('user_first_name').catch(() => null)
      : Promise.resolve(null)
  return namePromise
}
