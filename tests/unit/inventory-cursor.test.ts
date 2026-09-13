import { describe, expect, it } from 'vitest'

const cursor = require('../../cloudfunctions/inventoryApi/cursor') as {
  decodeCompletedCursor(value: string | null, signature: string): { completedAt: string; id: string } | null
  decodeKeyCursor(value: string | null, signature: string): { expiryDate: string; createdAt: string; id: string } | null
  encodeCompletedCursor(item: Record<string, unknown>, signature: string): string
  encodeKeyCursor(after: Record<string, string>, sort: string, signature: string): string
  querySignature(values: Record<string, unknown>): string
}

describe('inventory keyset cursors', () => {
  it('keeps all 60 rows when expiryDate and createdAt are identical', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      _id: `item-${String(index + 1).padStart(3, '0')}`,
      expiryDate: '2026-10-01',
      createdAt: '2026-09-13T01:02:03.000Z',
    }))
    const signature = cursor.querySignature({ sort: 'expiry_asc', pageSize: 30 })
    const collected: string[] = []
    let encoded: string | null = null

    do {
      const after = cursor.decodeKeyCursor(encoded, signature)
      const remaining = after ? rows.filter((row) => row._id > after.id) : rows
      const page = remaining.slice(0, 30)
      collected.push(...page.map((row) => row._id))
      const last = page.at(-1)
      encoded = remaining.length > 30 && last
        ? cursor.encodeKeyCursor({ expiryDate: last.expiryDate, createdAt: last.createdAt, id: last._id }, 'expiry_asc', signature)
        : null
    } while (encoded)

    expect(collected).toEqual(rows.map((row) => row._id))
    expect(new Set(collected).size).toBe(60)
  })

  it('rejects a cursor when filters or page size changed', () => {
    const firstSignature = cursor.querySignature({ search: '', pageSize: 30 })
    const nextSignature = cursor.querySignature({ search: '牛奶', pageSize: 30 })
    const encoded = cursor.encodeKeyCursor({
      expiryDate: '2026-10-01',
      createdAt: '2026-09-13T01:02:03.000Z',
      id: 'item-030',
    }, 'expiry_asc', firstSignature)

    expect(() => cursor.decodeKeyCursor(encoded, nextSignature)).toThrow(/分页位置已失效/)
  })

  it('history and trash cursor carries completedAt, id, and query signature', () => {
    const signature = cursor.querySignature({ scope: 'trash', search: '', pageSize: 30 })
    const encoded = cursor.encodeCompletedCursor({
      _id: 'item-030',
      completedAt: new Date('2026-09-13T01:02:03.000Z'),
    }, signature)

    expect(cursor.decodeCompletedCursor(encoded, signature)).toEqual({
      completedAt: '2026-09-13T01:02:03.000Z',
      id: 'item-030',
    })
  })
})
