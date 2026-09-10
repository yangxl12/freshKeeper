import { describe, expect, it } from 'vitest'

type Generate = (messages: Array<{ role: string; content: string }>) => Promise<{ text: string; usage?: unknown }>

const { aiParseText, extractJson } = require('../../cloudfunctions/quickEntryApi/ai-parse') as {
  aiParseText(options: {
    text: string
    serverToday?: string
    generate?: Generate
    timeoutMs?: number
    retryDelayMs?: number
  }): Promise<{
    items: Array<Record<string, unknown>>
    serverToday: string
    parserVersion: string
  }>
  extractJson(raw: unknown): Record<string, unknown> | null
}

const aiClient = require('../../cloudfunctions/quickEntryApi/ai-client') as {
  aiEnabled(): boolean
  aiTimeoutMs(): number
  createTextGenerator(options?: { sdk?: unknown }): Generate
  extractText(result: unknown): string
  isLocalDebug(): boolean
  modelName(): string
  providerName(): string
}

/** 临时改写环境变量，跑完立刻还原。 */
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

describe('ai client adapter', () => {
  it('defaults to enabled so a fresh deployment is not dead', () => {
    withEnv('QUICK_ENTRY_AI_ENABLED', undefined, () => {
      expect(aiClient.aiEnabled()).toBe(true)
    })
    withEnv('QUICK_ENTRY_AI_ENABLED', 'true', () => expect(aiClient.aiEnabled()).toBe(true))
  })

  it('can be killed from the cloud console without redeploying', () => {
    for (const value of ['false', '0', 'off', 'FALSE', ' no ']) {
      withEnv('QUICK_ENTRY_AI_ENABLED', value, () => expect(aiClient.aiEnabled()).toBe(false))
    }
  })

  // 本地调试没有云开发网关注入，/v1/ai/ 请求会 404——每次白等约 0.5s 才降级，日志还误导人。
  it('skips AI inside the devtool local debugger', () => {
    withEnv('TENCENTCLOUD_RUNENV', 'WX_LOCAL_SCF', () => {
      expect(aiClient.isLocalDebug()).toBe(true)
      withEnv('QUICK_ENTRY_AI_ENABLED', undefined, () => {
        withEnv('QUICK_ENTRY_AI_LOCAL_DEBUG', undefined, () => expect(aiClient.aiEnabled()).toBe(false))
        // 逃生门：确实要联调云端 AI 时显式打开
        withEnv('QUICK_ENTRY_AI_LOCAL_DEBUG', 'true', () => expect(aiClient.aiEnabled()).toBe(true))
      })
      // 急停开关优先于本地调试逃生门
      withEnv('QUICK_ENTRY_AI_ENABLED', 'false', () => {
        withEnv('QUICK_ENTRY_AI_LOCAL_DEBUG', 'true', () => expect(aiClient.aiEnabled()).toBe(false))
      })
    })

    withEnv('TENCENTCLOUD_RUNENV', 'SCF', () => {
      expect(aiClient.isLocalDebug()).toBe(false)
      withEnv('QUICK_ENTRY_AI_ENABLED', undefined, () => {
        withEnv('QUICK_ENTRY_AI_LOCAL_DEBUG', undefined, () => expect(aiClient.aiEnabled()).toBe(true))
      })
    })
  })

  it('keeps the hunyuan-v3 / hy3 defaults and allows env overrides', () => {
    withEnv('QUICK_ENTRY_AI_PROVIDER', undefined, () => expect(aiClient.providerName()).toBe('hunyuan-v3'))
    withEnv('QUICK_ENTRY_AI_MODEL', undefined, () => expect(aiClient.modelName()).toBe('hy3'))
    withEnv('QUICK_ENTRY_AI_MODEL', 'hy3-preview', () => expect(aiClient.modelName()).toBe('hy3-preview'))
  })

  it('never lets the AI budget exceed the shared quick-entry timeout', () => {
    withEnv('QUICK_ENTRY_AI_TIMEOUT_MS', undefined, () => {
      withEnv('QUICK_ENTRY_TIMEOUT_MS', undefined, () => expect(aiClient.aiTimeoutMs()).toBe(6000))
      withEnv('QUICK_ENTRY_TIMEOUT_MS', '3000', () => expect(aiClient.aiTimeoutMs()).toBe(3000))
    })
    withEnv('QUICK_ENTRY_AI_TIMEOUT_MS', '9000', () => {
      withEnv('QUICK_ENTRY_TIMEOUT_MS', '8000', () => expect(aiClient.aiTimeoutMs()).toBe(8000))
    })
  })

  it('reads generated text from either result.text or result.messages', () => {
    expect(aiClient.extractText({ text: '{"items":[]}' })).toBe('{"items":[]}')
    expect(aiClient.extractText('裸字符串')).toBe('裸字符串')
    expect(aiClient.extractText({ messages: [{ content: ' ' }, { content: '第二个' }] })).toBe('第二个')
    expect(aiClient.extractText({ messages: [{ content: [{ text: '分段' }, { text: '内容' }] }] })).toBe('分段内容')
    expect(aiClient.extractText({})).toBe('')
  })

  it('drives the sdk through createModel(provider).generateText({ model, messages })', async () => {
    const calls: unknown[] = []
    const sdk = {
      ai: () => ({
        createModel: (provider: string) => {
          calls.push(provider)
          return {
            generateText: async (input: { model: string }) => {
              calls.push(input.model)
              return { text: '{"items":[]}', usage: { total_tokens: 1 } }
            },
          }
        },
      }),
    }
    const generate = aiClient.createTextGenerator({ sdk })
    const result = await generate([{ role: 'user', content: '牛奶' }])
    expect(result.text).toBe('{"items":[]}')
    expect(result.usage).toEqual({ total_tokens: 1 })
    expect(calls).toEqual(['hunyuan-v3', 'hy3'])
  })

  it('builds the generator lazily so the sdk is only needed when actually called', () => {
    expect(typeof aiClient.createTextGenerator()).toBe('function')
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
          evidence: { name: '瓜子', quantity: '一包', unit: '一包' },
        })],
      }),
    })
    expect(result.items[0].quantity).toBe(1)
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
      text: '酸奶1盒还有3天到期，面包2026年2月30日到期',
      serverToday: today,
      generate: reply({
        items: [
          item({ name: '酸奶', quantity: '1', unit: '盒', storageLocation: null, dateFacts: [{ kind: 'relative', offsetDays: '3', label: 'expiry', rawText: '还有3天到期' }], evidence: { name: '酸奶', quantity: '1盒', unit: '1盒' } }),
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

describe('ai parse evidence back-link', () => {
  it('drops a quantity the source text never mentions', async () => {
    const result = await aiParseText({
      text: '买了牛奶',
      serverToday: today,
      generate: reply({ items: [item({ name: '牛奶', quantity: 1, unit: null, storageLocation: null, evidence: { name: '牛奶' } })] }),
    })
    expect(result.items[0].name).toBe('牛奶')
    expect(result.items[0].quantity).toBeUndefined()
  })

  it('keeps a Chinese-numeral quantity whose evidence traces back', async () => {
    const result = await aiParseText({
      text: '买了三个苹果',
      serverToday: today,
      generate: reply({ items: [item({ name: '苹果', quantity: 3, unit: null, storageLocation: null, evidence: { name: '苹果', quantity: '三个' } })] }),
    })
    expect(result.items[0].quantity).toBe(3)
    expect(result.items[0].unit).toBeUndefined()
  })

  it('does not let a digit hide inside a longer number', async () => {
    const result = await aiParseText({
      text: '牛奶2026年9月12日到期',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '牛奶', quantity: 2, unit: null, storageLocation: null,
          dateFacts: [{ kind: 'absolute', year: 2026, month: 9, day: 12, label: 'expiry', rawText: '2026年9月12日到期' }],
        })],
      }),
    })
    expect(result.items[0].quantity).toBeUndefined()
    expect(result.items[0].dateCandidates?.[0].date).toBe('2026-09-12')
  })

  it('drops a date fact whose rawText is not in the source text', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({
        items: [item({ name: '牛奶', quantity: null, unit: null, storageLocation: null, dateFacts: [{ kind: 'absolute', month: 9, day: 12, label: 'expiry', rawText: '9月12日过期' }] })],
      }),
    })
    expect(result.items[0].dateCandidates).toEqual([])
  })

  it('drops an invented unit and keeps the storage location traced through its phrase', async () => {
    const result = await aiParseText({
      text: '牛奶放冰箱',
      serverToday: today,
      generate: reply({ items: [item({ name: '牛奶', quantity: null, unit: '盒', storageLocation: '冰箱', evidence: { name: '牛奶', storageLocation: '放冰箱' } })] }),
    })
    expect(result.items[0].unit).toBeUndefined()
    expect(result.items[0].storageLocation).toBe('冰箱')
  })

  it('tolerates whitespace and full-width digits when tracing evidence', async () => {
    const result = await aiParseText({
      text: '鲜牛奶 ２ 盒',
      serverToday: today,
      generate: reply({ items: [item({ name: '鲜牛奶', quantity: 2, unit: '盒', storageLocation: null, evidence: { name: '鲜牛奶', quantity: '２ 盒', unit: '２ 盒' } })] }),
    })
    expect(result.items[0]).toMatchObject({ name: '鲜牛奶', quantity: 2, unit: '盒' })
  })

  it('exempts category from the evidence requirement but keeps the whitelist', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({ items: [item({ name: '牛奶', quantity: null, unit: null, storageLocation: null, category: 'medicine' })] }),
    })
    expect(result.items[0].category).toBe('medicine')
  })

  it('degrades when every field is hallucinated away', async () => {
    await expect(aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({ items: [item({ name: '酸奶', quantity: 5, unit: '杯', storageLocation: '冰箱' })] }),
    })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
  })
})

describe('ai parse acceptance cases', () => {
  it('parses a fully specified sentence without confirmation', async () => {
    const result = await aiParseText({
      text: '牛奶2盒9月12日过期放冰箱',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '牛奶', quantity: 2, unit: '盒', storageLocation: '冰箱',
          dateFacts: [{ kind: 'absolute', month: 9, day: 12, label: 'expiry', rawText: '9月12日过期' }],
          evidence: { name: '牛奶', quantity: '2盒', unit: '2盒', storageLocation: '放冰箱' },
        })],
      }),
    })
    expect(result.items[0]).toMatchObject({ name: '牛奶', quantity: 2, unit: '盒', storageLocation: '冰箱' })
    expect(result.items[0].dateCandidates?.[0]).toMatchObject({ date: '2026-09-12', role: 'expiry' })
  })

  it('computes a relative expiry for 瓜子一包2周后过期', async () => {
    const result = await aiParseText({
      text: '瓜子一包2周后过期',
      serverToday: today,
      generate: reply({
        items: [item({
          name: '瓜子', quantity: 1, unit: '包', storageLocation: null,
          dateFacts: [{ kind: 'relative', offsetDays: 14, label: 'expiry', rawText: '2周后过期' }],
          evidence: { name: '瓜子', quantity: '一包', unit: '一包' },
        })],
      }),
    })
    expect(result.items[0]).toMatchObject({ name: '瓜子', quantity: 1, unit: '包' })
    expect(result.items[0].dateCandidates?.[0].date).toBe('2026-09-24')
  })

  it('keeps a unit-less quantity and leaves the unit null', async () => {
    const result = await aiParseText({
      text: '买了三个苹果',
      serverToday: today,
      generate: reply({ items: [item({ name: '苹果', quantity: 3, unit: null, storageLocation: null, evidence: { name: '苹果', quantity: '三个' } })] }),
    })
    expect(result.items[0]).toMatchObject({ name: '苹果', quantity: 3 })
    expect(result.items[0].unit).toBeUndefined()
  })

  it('never fills in a default quantity for a bare name', async () => {
    const result = await aiParseText({
      text: '牛奶',
      serverToday: today,
      generate: reply({ items: [item({ name: '牛奶', quantity: null, unit: null, storageLocation: null, evidence: { name: '牛奶' } })] }),
    })
    expect(result.items[0]).toMatchObject({ name: '牛奶' })
    expect(result.items[0].quantity).toBeUndefined()
    expect(result.items[0].unit).toBeUndefined()
    expect(result.items[0].dateCandidates).toEqual([])
  })

  it('maps a shelf-life sentence onto shelf_life mode', async () => {
    const result = await aiParseText({
      text: '今天买的酸奶，保质期21天',
      serverToday: today,
      generate: reply({ items: [item({ name: '酸奶', quantity: null, unit: null, storageLocation: null, dateFacts: [{ kind: 'shelf_life', value: 21, unit: 'day', rawText: '保质期21天' }], evidence: { name: '酸奶' } })] }),
    })
    expect(result.items[0]).toMatchObject({ name: '酸奶', expiryInputMode: 'shelf_life', shelfLifeValue: 21, shelfLifeUnit: 'day' })
  })
})

describe('ai parse concurrency backoff', () => {
  function concurrencyError() {
    const error = new Error('EXCEED_CONCURRENT_REQUEST_LIMIT') as Error & { code?: string }
    error.code = 'EXCEED_CONCURRENT_REQUEST_LIMIT'
    return error
  }

  it('retries once when the model hits the concurrency ceiling', async () => {
    let calls = 0
    const generate: Generate = async () => {
      calls += 1
      if (calls === 1) throw concurrencyError()
      return { text: JSON.stringify({ items: [{ name: '牛奶', quantity: null, unit: null, storageLocation: null, dateFacts: [], evidence: { name: '牛奶' } }] }) }
    }
    const result = await aiParseText({ text: '牛奶', serverToday: today, generate, retryDelayMs: 1 })
    expect(result.items[0].name).toBe('牛奶')
    expect(calls).toBe(2)
  })

  it('gives up after one retry so the caller can degrade', async () => {
    let calls = 0
    const generate: Generate = async () => { calls += 1; throw concurrencyError() }
    await expect(aiParseText({ text: '牛奶', serverToday: today, generate, retryDelayMs: 1 }))
      .rejects.toMatchObject({ code: 'EXCEED_CONCURRENT_REQUEST_LIMIT' })
    expect(calls).toBe(2)
  })

  it('does not retry ordinary failures', async () => {
    let calls = 0
    const generate: Generate = async () => { calls += 1; throw new Error('boom') }
    await expect(aiParseText({ text: '牛奶', serverToday: today, generate, retryDelayMs: 1 })).rejects.toThrow('boom')
    expect(calls).toBe(1)
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
