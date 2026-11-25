import { create } from 'zustand'
import { isTauri } from './backend'
import type { Update } from '@tauri-apps/plugin-updater'

// Desktop self-update. Asks the ccanvas update server (tauri.conf.json →
// plugins.updater) whether a newer signed release exists, downloads it in the
// background, then waits for the user to choose when to restart — a restart
// ends every running shell and agent, so it is never done unasked.

const RECHECK_MS = 6 * 60 * 60 * 1000

type UpdateState = {
  /** version that is downloaded and ready to install */
  ready: string | null
  /** release notes for that version */
  notes: string
  installing: boolean
  dismissed: boolean
  install: () => Promise<void>
  dismiss: () => void
}

let pending: Update | null = null

export const useUpdate = create<UpdateState>((set, get) => ({
  ready: null,
  notes: '',
  installing: false,
  dismissed: false,
  install: async () => {
    if (!pending || get().installing) return
    set({ installing: true })
    try {
      // on Windows this hands over to the installer and exits the app
      await pending.install()
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      console.error('[ccanvas] update install failed', err)
      set({ installing: false })
    }
  },
  dismiss: () => set({ dismissed: true }),
}))

async function checkOnce() {
  if (pending) return // already downloaded; waiting on the user
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return
    await update.download()
    pending = update
    useUpdate.setState({ ready: update.version, notes: update.body ?? '', dismissed: false })
  } catch (err) {
    // offline, server down, bad signature… try again on the next tick
    console.warn('[ccanvas] update check failed', err)
  }
}

/** Start checking for updates (desktop release builds only). A build made
 *  with VITE_NO_UPDATE_CHECK=1 never checks, so a local build from a fork or
 *  branch isn't offered the official release in its place. */
export function startUpdateChecks() {
  if (!isTauri() || import.meta.env.DEV) return
  if (import.meta.env.VITE_NO_UPDATE_CHECK === '1') return
  void checkOnce()
  setInterval(() => void checkOnce(), RECHECK_MS)
}
