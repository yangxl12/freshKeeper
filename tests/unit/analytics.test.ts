import { afterEach, describe, expect, it, vi } from 'vitest'

import { track, trackDuration } from '../../miniprogram/utils/analytics'

const originalWx = globalThis.wx

type Calls = Array<{ name: string; data: Record<string, unknown> }>

function stubWx(broken = false): Calls {
  const calls: Calls = []
  globalThis.wx = {
    reportEvent: vi.fn((name: string, data: Record<string, unknown>) => {
      if (broken) throw new Error('analytics unavailable')
      calls.push({ name, data })
    }),
  } as never
  return calls
}

afterEach(() => {
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

describe('analytics', () => {
  it('reports the event with its payload', () => {
    const calls = stubWx()
    track('item_used_up', { source: 'home' })
    expect(calls).toEqual([{ name: 'item_used_up', data: { source: 'home' } }])
  })

  it('appends durationMs and never reports a negative duration', () => {
    const calls = stubWx()
    const elapsed = trackDuration('home_first_screen', Date.now() - 120, {
      count: 30,
      result: 'success',
    })
    expect(elapsed).toBeGreaterThanOrEqual(120)
    expect(calls[0].data).toMatchObject({ count: 30, result: 'success' })
    expect(Number(calls[0].data.duration_ms)).toBeGreaterThanOrEqual(120)
    // 时钟回拨（用户改系统时间）不能报出负数。
    expect(trackDuration('home_first_screen', Date.now() + 10_000)).toBe(0)
  })

  it('stays silent when the analytics capability is missing', () => {
    stubWx(true)
    expect(() => track('item_used_up')).not.toThrow()
    expect(() => trackDuration('home_first_screen', Date.now())).not.toThrow()
  })

  it('stays silent on a runtime without reportEvent', () => {
    globalThis.wx = {} as never
    expect(() => track('item_used_up')).not.toThrow()
    expect(() => trackDuration('home_first_screen', Date.now())).not.toThrow()
  })
})
