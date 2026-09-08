import { describe, expect, it } from 'vitest'

const dateFacts = require('../../cloudfunctions/quickEntryApi/date-facts') as {
  normalizeTextResult(payload: Record<string, unknown>, today: string): {
    items: Array<{ dateCandidates: Array<{ date: string | null; role: string }> }>
  }
}

describe('quick entry cloud facts', () => {
  it('normalizes relative and month-day facts against server today', () => {
    const result = dateFacts.normalizeTextResult({
      items: [{
        name: '牛奶',
        dateFacts: [
          { kind: 'relative', label: 'expiry', rawText: '还有 3 天', offsetDays: 3 },
          { kind: 'expiry', rawText: '9月12日', month: 9, day: 12 },
        ],
      }],
    }, '2026-09-10')
    expect(result.items[0].dateCandidates).toEqual([
      expect.objectContaining({ date: '2026-09-13', role: 'expiry' }),
      expect.objectContaining({ date: '2026-09-12', role: 'expiry' }),
    ])
  })

  it('rejects more than five provider drafts', () => {
    expect(() => dateFacts.normalizeTextResult({ items: Array.from({ length: 6 }, () => ({ dateFacts: [] })) }, '2026-09-10'))
      .toThrow('一次最多生成 5 条草稿')
  })
})
