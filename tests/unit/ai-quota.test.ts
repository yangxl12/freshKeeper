import { beforeEach, describe, expect, it } from 'vitest'

const quota = require('../../cloudfunctions/quickEntryApi/ai-quota') as {
  cacheKey(text: string, serverToday: string): string
  consumeAiQuota(db: any, openid: string, dateKey: string): Promise<{ allowed: boolean; used: number; limit: number; remaining: number; nearLimit: boolean }>
  dailyLimit(): number
  globalDailyLimit(): number
  readCachedResult(key: string): unknown
  resetAiState(): void
  writeCachedResult(key: string, result: unknown): void
}

const today = '2026-09-10'

async function withEnv(name: string, value: string | undefined, run: () => unknown | Promise<unknown>) {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await run()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

function createQuotaDb() {
  const store = new Map<string, Record<string, unknown>>()
  const collection = () => ({
    where(filter: { _id: { values: string[] } }) {
      return { get: async () => ({ data: filter._id.values.map((id) => store.get(id)).filter(Boolean) }) }
    },
    doc(id: string) {
      return { set: async ({ data }: { data: Record<string, unknown> }) => { store.set(id, { _id: id, ...data }) } }
    },
  })
  const db = {
    command: { in: (values: string[]) => ({ values }) },
    serverDate: () => new Date(),
    runTransaction: async (run: (transaction: { collection: typeof collection }) => Promise<unknown>) => run({ collection }),
  }
  return { db, store }
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
  it('defaults to bounded user/global limits and accepts explicit overrides', async () => {
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', undefined, () => expect(quota.dailyLimit()).toBe(50))
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '3', () => expect(quota.dailyLimit()).toBe(3))
    await withEnv('QUICK_ENTRY_AI_GLOBAL_DAILY_LIMIT', undefined, () => expect(quota.globalDailyLimit()).toBe(500))
  })

  it('blocks the call past the persistent user limit', async () => {
    const { db } = createQuotaDb()
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '2', async () => {
      expect(await quota.consumeAiQuota(db, 'openid-a', today)).toMatchObject({ allowed: true, used: 1, remaining: 1 })
      expect(await quota.consumeAiQuota(db, 'openid-a', today)).toMatchObject({ allowed: true, used: 2, remaining: 0 })
      expect(await quota.consumeAiQuota(db, 'openid-a', today)).toMatchObject({ allowed: false, used: 2, remaining: 0 })
    })
  })

  it('isolates user counters while enforcing a shared global limit', async () => {
    const { db } = createQuotaDb()
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '2', async () => {
      await withEnv('QUICK_ENTRY_AI_GLOBAL_DAILY_LIMIT', '2', async () => {
        expect((await quota.consumeAiQuota(db, 'openid-a', today)).allowed).toBe(true)
        expect((await quota.consumeAiQuota(db, 'openid-b', today)).allowed).toBe(true)
        expect((await quota.consumeAiQuota(db, 'openid-a', today)).allowed).toBe(false)
      })
    })
  })

  it('flags the 80 percent watermark for the usage log', async () => {
    const { db } = createQuotaDb()
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '10', async () => {
      for (let index = 0; index < 7; index += 1) expect((await quota.consumeAiQuota(db, 'openid-a', today)).nearLimit).toBe(false)
      expect((await quota.consumeAiQuota(db, 'openid-a', today)).nearLimit).toBe(true)
    })
  })

  it('starts a fresh persistent counter on a new day', async () => {
    const { db, store } = createQuotaDb()
    await withEnv('QUICK_ENTRY_AI_DAILY_LIMIT', '1', async () => {
      expect((await quota.consumeAiQuota(db, 'openid-a', today)).allowed).toBe(true)
      expect((await quota.consumeAiQuota(db, 'openid-a', today)).allowed).toBe(false)
      expect((await quota.consumeAiQuota(db, 'openid-a', '2026-09-11')).allowed).toBe(true)
      expect(store.size).toBe(4)
    })
  })
})
