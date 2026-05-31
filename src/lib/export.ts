// Export a workspace to SVG (and rasterized PNG). Vectors, shapes, arrows,
// text, frames and images render faithfully; live widgets (terminals, web,
// editors) export as labelled placeholder cards since their content is dynamic.

import type { CanvasElement, Workspace } from './types'
import { WIDGET_ACCENT } from './types'
import { boundsOfMany, resolvedArrow } from './geometry'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function arrowSvg(a: CanvasElement & { type: 'arrow' }): string {
  const { x1, y1, x2, y2, color, size } = a
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.hypot(x2 - x1, y2 - y1)
  const head = Math.min(16 + size * 2, len * 0.4)
  const a1 = angle - Math.PI / 7
  const a2 = angle + Math.PI / 7
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${size}" stroke-linecap="round"/>` +
    `<path d="M ${x2 - head * Math.cos(a1)} ${y2 - head * Math.sin(a1)} L ${x2} ${y2} L ${x2 - head * Math.cos(a2)} ${y2 - head * Math.sin(a2)}" fill="none" stroke="${color}" stroke-width="${size}" stroke-linecap="round" stroke-linejoin="round"/>`
  )
}

function elementSvg(el: CanvasElement, byId: Map<string, CanvasElement>): string {
  switch (el.type) {
    case 'draw': {
      let d = ''
      for (let i = 0; i < el.points.length; i += 2)
        d += `${i === 0 ? 'M' : 'L'} ${el.points[i]} ${el.points[i + 1]} `
      return `<path d="${d}" fill="none" stroke="${el.color}" stroke-width="${el.size * 1.6}" stroke-linecap="round" stroke-linejoin="round"/>`
    }
    case 'arrow':
      return arrowSvg(resolvedArrow(el, byId))
    case 'rect':
      return `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="6" fill="none" stroke="${el.color}" stroke-width="${el.size}"/>`
    case 'ellipse':
      return `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" fill="none" stroke="${el.color}" stroke-width="${el.size}"/>`
    case 'text':
      return `<text x="${el.x}" y="${el.y + el.fontSize}" font-family="monospace" font-size="${el.fontSize}" fill="${el.color}" xml:space="preserve">${esc(el.text)}</text>`
    case 'image':
      return `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" href="${el.src}" preserveAspectRatio="none"/>`
    case 'frame':
      return (
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="8" fill="none" stroke="${el.color}" stroke-dasharray="6 5" stroke-width="1.5"/>` +
        `<text x="${el.x + 4}" y="${el.y - 6}" font-family="monospace" font-size="13" fill="${el.color}">${esc(el.title)}</text>`
      )
    case 'widget': {
      const accent = WIDGET_ACCENT[el.kind]
      return (
        `<g>` +
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="9" fill="#121419" stroke="#23262e"/>` +
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="26" rx="9" fill="#15171d"/>` +
        `<rect x="${el.x}" y="${el.y}" width="3" height="${el.h}" fill="${accent}"/>` +
        `<text x="${el.x + 12}" y="${el.y + 17}" font-family="monospace" font-size="11" fill="#9a9892">${esc(el.kind)} · ${esc(el.title)}</text>` +
        `</g>`
      )
    }
  }
}

export function exportSvg(ws: Workspace): string {
  const els = [...ws.elements].sort((a, b) => a.z - b.z)
  const byId = new Map(ws.elements.map((e) => [e.id, e]))
  const b = boundsOfMany(ws.elements) ?? { x: 0, y: 0, w: 800, h: 600 }
  const pad = 40
  const vb = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
  const body = els
    // frames first so they sit behind
    .sort((a, b2) => (a.type === 'frame' ? -1 : 0) - (b2.type === 'frame' ? -1 : 0))
    .map((el) => elementSvg(el, byId))
    .join('\n')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vb.w}" height="${vb.h}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">` +
    `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#0a0b0d"/>` +
    body +
    `</svg>`
  )
}

function download(name: string, href: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.click()
}

export function downloadSvg(ws: Workspace) {
  const svg = exportSvg(ws)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  download(`${ws.name}.svg`, url)
  URL.revokeObjectURL(url)
}

export async function downloadPng(ws: Workspace, scale = 2) {
  const svg = exportSvg(ws)
  const b = boundsOfMany(ws.elements) ?? { x: 0, y: 0, w: 800, h: 600 }
  const pad = 40
  const w = (b.w + pad * 2) * scale
  const h = (b.h + pad * 2) * scale
  const img = new Image()
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('svg render failed'))
    img.src = svgUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  download(`${ws.name}.png`, canvas.toDataURL('image/png'))
}
