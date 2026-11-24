// ccanvas update endpoint for the Tauri updater.
//
//   GET /update/{target}/{arch}/{current_version}
//     200 { version, notes, pub_date, url, signature }  a newer build exists
//     204                                               already up to date
//
// The release workflow (tauri-action) attaches a signed `latest.json` to every
// GitHub release; this reads the one on the latest release, picks the entry
// for the caller's platform, and answers only when it is newer than what the
// caller runs. Responses are cached at the edge for a few minutes so a burst
// of app launches doesn't hit GitHub each time.

const REPO = process.env.GITHUB_REPO || 'DevoidSloth/ccanvas'
const MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`
const CACHE = 'public, s-maxage=300, stale-while-revalidate=600'

/** Compare dotted versions numerically (a leading "v" and any -pre/+build ignored). */
export function newer(a, b) {
  const parse = (v) =>
    String(v).replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** The manifest entry for a platform; Windows may be listed per installer. */
export function pickPlatform(platforms, target, arch) {
  const key = `${target}-${arch}`
  return (
    platforms[key] ??
    (target === 'windows' ? platforms[`${key}-nsis`] ?? platforms[`${key}-msi`] : undefined) ??
    (target === 'darwin' ? platforms[`${key}-app`] : undefined) ??
    (target === 'linux' ? platforms[`${key}-appimage`] : undefined)
  )
}

const noUpdate = () => new Response(null, { status: 204, headers: { 'Cache-Control': CACHE } })

export async function GET(request) {
  const q = new URL(request.url).searchParams
  const target = q.get('target')
  const arch = q.get('arch')
  const current = q.get('version')
  if (!target || !arch || !current)
    return Response.json({ error: 'expected /update/{target}/{arch}/{current_version}' }, { status: 400 })

  let manifest
  try {
    const r = await fetch(MANIFEST, { redirect: 'follow' })
    // no release yet, or the latest one was built without updater artifacts
    if (!r.ok) return noUpdate()
    manifest = await r.json()
  } catch {
    return noUpdate()
  }

  if (!manifest?.version || !newer(manifest.version, current)) return noUpdate()
  const entry = pickPlatform(manifest.platforms ?? {}, target, arch)
  if (!entry?.url || !entry?.signature) return noUpdate()

  return Response.json(
    {
      version: String(manifest.version).replace(/^v/i, ''),
      notes: manifest.notes ?? '',
      pub_date: manifest.pub_date,
      url: entry.url,
      signature: entry.signature,
    },
    { headers: { 'Cache-Control': CACHE } },
  )
}
