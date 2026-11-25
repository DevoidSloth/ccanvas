import { describe, expect, it, beforeEach } from 'vitest'
import { GPU_POOL, acquireGpu, fitsGpu, gpuHolders, releaseGpu } from './termGpu'

describe('fitsGpu', () => {
  it('takes an ordinary terminal at 1× and a moderate zoom', () => {
    expect(fitsGpu(900, 600, 1, 2)).toBe(true)
    expect(fitsGpu(900, 600, 2, 2)).toBe(true)
  })
  it('refuses a buffer past the pixel budget or the side limit', () => {
    expect(fitsGpu(900, 600, 4, 2)).toBe(false) // 7200×4800
    expect(fitsGpu(4200, 300, 1, 2)).toBe(false) // 8400 wide
  })
  it('refuses an empty terminal', () => {
    expect(fitsGpu(0, 600, 1, 2)).toBe(false)
  })
})

describe('GPU pool', () => {
  beforeEach(() => {
    for (const id of gpuHolders()) releaseGpu(id)
  })

  it('revokes the least recently used holder when full', () => {
    const revoked: string[] = []
    for (let i = 0; i < GPU_POOL; i++) acquireGpu(`t${i}`, () => revoked.push(`t${i}`))
    // t0 asks again, so t1 is now the oldest
    acquireGpu('t0', () => revoked.push('t0'))
    acquireGpu('new', () => revoked.push('new'))
    expect(revoked).toEqual(['t1'])
    expect(gpuHolders()).toHaveLength(GPU_POOL)
    expect(gpuHolders()).toContain('new')
    expect(gpuHolders()).not.toContain('t1')
  })

  it('frees a slot on release', () => {
    const revoked: string[] = []
    for (let i = 0; i < GPU_POOL; i++) acquireGpu(`t${i}`, () => revoked.push(`t${i}`))
    releaseGpu('t3')
    acquireGpu('new', () => revoked.push('new'))
    expect(revoked).toEqual([])
  })
})
