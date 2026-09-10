import { beforeEach, describe, expect, it } from 'vitest'

const quota = require('../../cloudfunctions/quickEntryApi/ai-quota') as {
  cacheKey(text: string, serverToday: string): string
  consumeAiQuota(openid: string, dateKey: string): { allowed: boolean; used: number; limit: number; remaining: number; nearLimit: boolean }
  dailyLimit(): number
  peekAiQuota(openid: string, dateKey: string): { used: number; limit: number; cacheSize: number }
  readCachedResult(key: string): unknown
  resetAiState(): void
  writeCachedResult(key: string, result: unknown): void
}

const today = '2026-09-10'

function withEnv(name: string, value: string | undefined, run: () => void) {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    run()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

beforeEach(() => {
  quota.resetAiState()
})

describe('ai result cache', () => {
  it('keys on normalized text so whitespace and casing do not cost a second call', () => {
    expect(quota.cacheKey('牛奶 ２盒', today)).toBe(quota.cacheKey('牛奶2盒', today))
    expect(quota.cacheKey('Milk 2', today)).toBe(quota.cacheKey('milk2', today))
  })

  it('scopes the cache to the server day so relative dates cannot go stale', () => {
    expect(quota.cacheKey('牛奶', today)).not.toBe(quota.cacheKey('牛奶', '2026-09-11'))
  })

  it('round-trips a result without handing out a shared mutable reference', () => {
    const key = quota.cacheKey('牛奶', today)
    const stored = { items: [{ name: '牛奶', dateCandidates: [] }] }
    quota.writeCachedResult(key, stored)
    stored.items[0].name = '被改坏了'
    expect(quota.readCachedResult(key)).toEqual({ items: [{ name: '牛奶', dateCandidates: [] }] })
  })

  it('returns null for a missing key', () => {
    expect(quota.readCachedResult(quota.cacheKey('没缓存过', today))).toBeNull()
  })
})

describe('ai daily quota', () => {
  it('defaults to 50 calls per day and can be overridden from the cloud console', () => {
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', undefined, () => expect(quota.dailyLimit()).toBe(50))
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '3', () => expect(quota.dailyLimit()).toBe(3))
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', 'abc', () => expect(quota.dailyLimit()).toBe(50))
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '0', () => expect(quota.dailyLimit()).toBe(50))
  })

  it('blocks the call past the limit instead of silently spending quota', () => {
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '2', () => {
      expect(quota.consumeAiQuota('openid-a', today)).toMatchObject({ allowed: true, used: 1, remaining: 1 })
      expect(quota.consumeAiQuota('openid-a', today)).toMatchObject({ allowed: true, used: 2, remaining: 0 })
      expect(quota.consumeAiQuota('openid-a', today)).toMatchObject({ allowed: false, used: 2, remaining: 0 })
    })
  })

  it('isolates the counters per openid', () => {
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '1', () => {
      expect(quota.consumeAiQuota('openid-a', today).allowed).toBe(true)
      expect(quota.consumeAiQuota('openid-b', today).allowed).toBe(true)
      expect(quota.consumeAiQuota('openid-a', today).allowed).toBe(false)
    })
  })

  it('flags the 80 percent watermark for the usage log', () => {
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '10', () => {
      for (let index = 0; index < 7; index += 1) expect(quota.consumeAiQuota('openid-a', today).nearLimit).toBe(false)
      expect(quota.consumeAiQuota('openid-a', today).nearLimit).toBe(true)
    })
  })

  it('starts a fresh counter on a new day', () => {
    withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '1', () => {
      expect(quota.consumeAiQuota('openid-a', today).allowed).toBe(true)
      expect(quota.consumeAiQuota('openid-a', today).allowed).toBe(false)
      expect(quota.consumeAiQuota('openid-a', '2026-09-11').allowed).toBe(true)
      expect(quota.peekAiQuota('openid-a', '2026-09-11')).toMatchObject({ used: 1, limit: 1 })
    })
  })
})
