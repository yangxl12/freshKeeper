import { describe, expect, it } from 'vitest'

type Generate = (messages: Array<{ role: string; content: string }>) => Promise<{ text: string; usage?: unknown }>

const { aiParseText, extractJson } = require('../../cloudfunctions/quickEntryApi/ai-parse') as {
  aiParseText(options: {
    text: string
    serverToday?: string
    generate?: Generate
    timeoutMs?: number
  }): Promise<{
    items: Array<Record<string, unknown>>
    serverToday: string
    parserVersion: string
  }>
  extractJson(raw: unknown): Record<string, unknown> | null
}

const today = '2026-09-10'

/** 假 AI client：不真调模型，输出完全由用例决定。 */
function reply(body: unknown): Generate {
  return async () => ({ text: typeof body === 'string' ? body : JSON.stringify(body) })
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    name: '牛奶',
    quantity: 2,
    unit: '盒',
    category: 'food',
    storageLocation: '冰箱',
    dateFacts: [],
    ...overrides,
  }
}

describe('ai parse json extraction', () => {
  it('strips markdown fences and surrounding prose', () => {
    expect(extractJson('```json\n{"items":[]}\n```')).toEqual({ items: [] })
    expect(extractJson('好的，结果如下：{"items":[{"name":"牛奶"}]} 以上。')).toEqual({ items: [{ name: '牛奶' }] })
  })

  it('returns null for truncated or non-json output', () => {
    expect(extractJson('{"items":[{"name":"牛奶"')).toBeNull()
    expect(extractJson('我不确定')).toBeNull()
    expect(extractJson(null)).toBeNull()
  })
})

describe('ai parse happy path', () => {
  it('maps a fully specified sentence without confirmation', async () => {
    const result = await aiParseText({
      text: '鲜牛奶2盒9月12日到期，放冰箱',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '鲜牛奶',
          dateFacts: [{ kind: 'absolute', month: 9, day: 12, label: 'expiry', rawText: '9月12日到期' }],
        })],
      }),
    })
    expect(result.parserVersion).toBe('ai-v1')
    expect(result.serverToday).toBe(today)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      name: '鲜牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '冰箱',
    })
    expect(result.items[0].dateCandidates).toEqual([
      expect.objectContaining({ date: '2026-09-12', role: 'expiry', complete: true, source: 'text' }),
    ])
  })

  it('accepts markdown-wrapped output', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply('```json\n{"items":[{"name":"牛奶","quantity":null}]}\n```'),
    })
    expect(result.items[0]).toMatchObject({ name: '牛奶' })
    expect(result.items[0].quantity).toBeUndefined()
  })

  it('computes relative dates on the server, never on the model', async () => {
    const result = await aiParseText({
      text: '瓜子一包2周后过期',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '瓜子', quantity: 1, unit: '包', storageLocation: null,
          dateFacts: [{ kind: 'relative', offsetDays: 14, label: 'expiry', rawText: '2周后过期' }],
        })],
      }),
    })
    expect(result.items[0].dateCandidates?.[0]).toMatchObject({ date: '2026-09-24', role: 'expiry' })
  })

  it('keeps shelf-life mode with a positive integer and whitelisted unit', async () => {
    const result = await aiParseText({
      text: '酸奶保质期21天',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '酸奶', quantity: null, unit: null, storageLocation: null,
          dateFacts: [{ kind: 'shelf_life', value: 21, unit: 'day', rawText: '保质期21天' }],
        })],
      }),
    })
    expect(result.items[0]).toMatchObject({ expiryInputMode: 'shelf_life', shelfLifeValue: 21, shelfLifeUnit: 'day' })
  })

  it('coerces numeric strings but drops unusable dates', async () => {
    const result = await aiParseText({
      text: '酸奶还有3天到期，面包2026年2月30日到期',
      serverToday: today,
      generate: reply({
        items: [
          item({ name: '酸奶', quantity: '1', unit: null, storageLocation: null, dateFacts: [{ kind: 'relative', offsetDays: '3', label: 'expiry', rawText: '还有3天到期' }] }),
          item({ name: '面包', quantity: null, unit: null, storageLocation: null, dateFacts: [{ kind: 'absolute', year: 2026, month: 2, day: 30, label: 'expiry', rawText: '2026年2月30日到期' }] }),
        ],
      }),
    })
    expect(result.items[0].quantity).toBe(1)
    expect(result.items[0].dateCandidates?.[0].date).toBe('2026-09-13')
    expect(result.items[1].dateCandidates?.[0]).toMatchObject({ date: null, complete: false })
  })
})

describe('ai parse tolerant sanitizing', () => {
  it('drops only the dirty field and keeps the rest of the batch', async () => {
    const result = await aiParseText({
      text: '牛奶两盒明天到期；酸奶4杯后天到期',
      serverToday: today,
      generate: reply({
        items: [
          item({ name: '牛奶', quantity: '两盒', unit: '盒', dateFacts: [{ kind: 'relative', offsetDays: 1, label: 'expiry', rawText: '明天到期' }] }),
          item({ name: '酸奶', quantity: 4, unit: '杯', dateFacts: [{ kind: 'relative', offsetDays: 2, label: 'expiry', rawText: '后天到期' }] }),
        ],
      }),
    })
    expect(result.items).toHaveLength(2)
    expect(result.items[0].quantity).toBeUndefined()
    expect(result.items[0].unit).toBe('盒')
    expect(result.items[0].dateCandidates?.[0].date).toBe('2026-09-11')
    expect(result.items[1]).toMatchObject({ name: '酸奶', quantity: 4, unit: '杯' })
  })

  it('nulls an out-of-whitelist category and an unsupported shelf-life unit', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({
        items: [item({
          category: 'beverage',
          dateFacts: [{ kind: 'shelf_life', value: 3, unit: 'week', rawText: '保质期3周' }],
        })],
      }),
    })
    expect(result.items[0].category).toBeUndefined()
    expect(result.items[0].expiryInputMode).toBeUndefined()
    expect(result.items[0].shelfLifeValue).toBeUndefined()
  })

  it('drops candidates that carry neither a name nor a usable date', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({
        items: [item({ dateFacts: [{ kind: 'absolute', month: 9, day: 12, label: 'expiry' }] }), { name: null, dateFacts: ['乱码'] }],
      }),
    })
    expect(result.items).toHaveLength(1)
  })
})

describe('ai parse failure paths', () => {
  it('retries once on unparseable output, then fails as unavailable', async () => {
    let calls = 0
    const generate: Generate = async () => { calls += 1; return { text: '我想不出来' } }
    await expect(aiParseText({ text: '牛奶', serverToday: today, generate })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
    expect(calls).toBe(2)
  })

  it('recovers when the retry finally returns valid json', async () => {
    let calls = 0
    const generate: Generate = async () => {
      calls += 1
      return { text: calls === 1 ? '' : JSON.stringify({ items: [{ name: '牛奶' }] }) }
    }
    const result = await aiParseText({ text: '牛奶', serverToday: today, generate })
    expect(result.items[0].name).toBe('牛奶')
    expect(calls).toBe(2)
  })

  it('rejects more than five items', async () => {
    await expect(aiParseText({
      text: '六件物品',
      serverToday: today,
      generate: reply({ items: Array.from({ length: 6 }, (_value, index) => item({ name: `物品${index}`, storageLocation: null })) }),
    })).rejects.toMatchObject({ code: 'TOO_MANY_DRAFTS' })
  })

  it('degrade-signals an empty or conversational result', async () => {
    await expect(aiParseText({ text: '帮我看看今天天气', serverToday: today, generate: reply({ items: [] }) }))
      .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
  })

  it('signals QUICK_ENTRY_TIMEOUT when the model stalls', async () => {
    const generate: Generate = () => new Promise(() => {})
    await expect(aiParseText({ text: '牛奶', serverToday: today, generate, timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'QUICK_ENTRY_TIMEOUT' })
  })

  it('rejects empty input before touching the model', async () => {
    let called = false
    const generate: Generate = async () => { called = true; return { text: '{}' } }
    await expect(aiParseText({ text: '   ', serverToday: today, generate })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(called).toBe(false)
  })
})
