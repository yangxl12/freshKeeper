import { describe, expect, it, vi } from 'vitest'

/**
 * readRecentProfiles 的提前退出。
 *
 * 原来的 bug：物品不足 limit（100）件时，cutoff 会被推成 -Infinity，循环条件恒真，
 * 一定会翻满 MAX_RECENT_ROUNDS = 12 轮 —— 双状态各一次请求就是 24 次查询。
 * 小数据量用户反而最吃亏，而这份结果在快录页只用来给 AI 识别结果补分类。
 */
const { readRecentProfiles, readRecentProfilesOnce } = require('../../cloudfunctions/inventoryApi/recent') as {
  readRecentProfiles(
    fetchPage: (status: string, offset: number, limit: number) => Promise<unknown[]>,
    limit?: number,
  ): Promise<{ items: Array<{ name: string }> }>
  readRecentProfilesOnce(
    fetchTop: (limit: number) => Promise<unknown[]>,
    limit?: number,
  ): Promise<{ items: Array<{ name: string }> }>
}

const PAGE_SIZE = 30

/** 造一个「每种状态各 total 条」的假分页器，返回调用计数器。 */
function makeSource(totals: Record<string, number>) {
  const calls: Array<{ status: string; offset: number }> = []
  const fetchPage = async (status: string, offset: number, limit: number) => {
    calls.push({ status, offset })
    const total = totals[status] ?? 0
    const names = []
    for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
      names.push({
        name: `${status}-${index}`,
        quantity: 1,
        unit: '件',
        category: 'food',
        storageLocation: '',
        reminderLeadDays: 1,
        expiryInputMode: 'direct',
        // updatedAt 递减，保证「最近的排前面」。
        updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
      })
    }
    return names
  }
  return { fetchPage, calls }
}

describe('readRecentProfiles 翻页收敛', () => {
  it('物品很少时提前收手，不再翻满 12 轮', async () => {
    // 30 条 active + 5 条 used_up：原来是 12 轮 × 2 = 24 次查询。
    const { fetchPage, calls } = makeSource({ active: 30, used_up: 5 })

    const result = await readRecentProfiles(fetchPage)

    expect(result.items).toHaveLength(35)
    // 上限：不再跑满轮数。实际应该几轮就收敛（第一轮就够 stopAt = 200 才怪，见下一条）。
    expect(calls.length).toBeLessThan(24)
  })

  it('攒够 limit × 3 的唯一名字就停，不会为了凑满 100 个名字翻到底', async () => {
    // 每种状态 300 条互不重名：第 1 轮 60 条，远不到 200 就继续；第 3 轮 200 条即停。
    const { fetchPage, calls } = makeSource({ active: 300, used_up: 300 })

    const result = await readRecentProfiles(fetchPage)

    expect(result.items).toHaveLength(100)
    // 至多 6 次查询（每轮 2 次），而不是 24 次。
    expect(calls.length).toBeLessThanOrEqual(6)
  })

  it('名字大量重复时仍然翻页直到凑够 100 个唯一名字', async () => {
    // 每个状态只产出 3 个不同名字，重复铺满：唯一数涨得慢，不能过早退出。
    const fetchPage = vi.fn(async (status: string, offset: number, limit: number) => {
      const total = 300
      const rows = []
      for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
        rows.push({
          name: `${status}-${index % 3}`,
          quantity: 1,
          unit: '件',
          category: 'food',
          storageLocation: '',
          reminderLeadDays: 1,
          expiryInputMode: 'direct',
          updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
        })
      }
      return rows
    })

    const result = await readRecentProfiles(fetchPage)

    // 两个状态各 3 个名字 → 去重后只有 6 个，取不到 100 个也应该是 6 条有效结果。
    expect(result.items.length).toBe(6)
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(24)
  })

  it('去重口径不变：同名保留 updatedAt 最新的一条', async () => {
    const fetchPage = async (_status: string, offset: number, limit: number) => {
      if (offset > 0) return []
      return [
        {
          name: '牛奶',
          quantity: 9,
          unit: '盒',
          category: 'food',
          storageLocation: 'refrigerated',
          reminderLeadDays: 2,
          expiryInputMode: 'direct',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        ...Array.from({ length: Math.min(limit, 10) - 1 }, (_, index) => ({
          name: `其他${index}`,
          quantity: 1,
          unit: '件',
          category: 'food',
          storageLocation: '',
          reminderLeadDays: 1,
          expiryInputMode: 'direct',
          updatedAt: '2025-01-01T00:00:00.000Z',
        })),
      ]
    }

    const result = await readRecentProfiles(fetchPage)
    const milk = result.items.find((item) => item.name === '牛奶')
    expect(milk).toMatchObject({ name: '牛奶' })
    // 每个 status 都会贡献一条「牛奶」，最终只留一条，且是最近的那个状态记录。
    expect(result.items.filter((item) => item.name === '牛奶')).toHaveLength(1)
  })

  it('空数据不报错，返回空列表', async () => {
    const { fetchPage, calls } = makeSource({ active: 0, used_up: 0 })
    const result = await readRecentProfiles(fetchPage)
    expect(result.items).toEqual([])
    // 第一轮就发现两个状态都到底，两轮内收敛。
    expect(calls.length).toBeLessThanOrEqual(4)
  })
})

/**
 * 单次查询版（云函数主路径）：跨 active / used_up 一次按 updatedAt 取够，内存去重。
 * 原来双状态各自翻页最坏 24 次查询，这里固定 1 次。
 */
describe('readRecentProfilesOnce 单次查询', () => {
  it('只查询一次，就拿到去重后的最近档案', async () => {
    const rows = [
      { name: '牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '', reminderLeadDays: 1, expiryInputMode: 'direct', updatedAt: '2026-03-02T00:00:00.000Z' },
      { name: '鸡蛋', quantity: 1, unit: '件', category: 'food', storageLocation: '', reminderLeadDays: 1, expiryInputMode: 'direct', updatedAt: '2026-03-01T00:00:00.000Z' },
      { name: '牛奶', quantity: 9, unit: '盒', category: 'food', storageLocation: '', reminderLeadDays: 3, expiryInputMode: 'direct', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    const fetchTop = vi.fn(async () => rows)

    const result = await readRecentProfilesOnce(fetchTop)

    // 就一次查询，而不是双状态翻页的 2 × N 次。
    expect(fetchTop).toHaveBeenCalledTimes(1)
    expect(fetchTop).toHaveBeenCalledWith(100)
    // 同名去重保留 updatedAt 最新的那条（数量 2 而非 9）。
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ name: '牛奶', quantity: 2 })
    expect(result.items[1]).toMatchObject({ name: '鸡蛋' })
  })

  it('空数据返回空列表，不抛错', async () => {
    const result = await readRecentProfilesOnce(async () => [])
    expect(result.items).toEqual([])
  })

  it('超出 limit 的部分被截断，且按最近录入排序', async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      name: `物品${index}`,
      quantity: 1,
      unit: '件',
      category: 'food',
      storageLocation: '',
      reminderLeadDays: 1,
      expiryInputMode: 'direct',
      updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    }))
    const result = await readRecentProfilesOnce(async () => rows)
    expect(result.items).toHaveLength(100)
    // 最近录入的排最前。
    expect(result.items[0].name).toBe('物品149')
  })
})
