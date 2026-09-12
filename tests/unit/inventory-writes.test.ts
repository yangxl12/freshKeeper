import { describe, expect, it } from 'vitest'

const { createWriteService } = require('../../cloudfunctions/inventoryApi/writes') as {
  createWriteService(options: { db: unknown }): {
    moveToTrash(ownerId: string, event: unknown): Promise<Record<string, unknown>>
    removePermanently(ownerId: string, event: unknown): Promise<Record<string, unknown>>
    restore(ownerId: string, event: unknown): Promise<Record<string, unknown>>
    transition(ownerId: string, event: unknown, target: string): Promise<Record<string, unknown>>
  }
}

type Doc = Record<string, unknown>

const OWNER = 'openid-1'
const OTHER = 'openid-2'

/** 假 db：只实现 writes.js 用到的 where/update/remove/get，并记录调用次数。 */
function createFakeDb(options: { items?: Doc[]; reminders?: Doc[] } = {}) {
  const store: Record<string, Doc[]> = {
    inventory_items: (options.items ?? []).map((doc) => ({ ...doc })),
    reminder_jobs: (options.reminders ?? []).map((doc) => ({ ...doc })),
  }
  const calls: string[] = []

  const matches = (doc: Doc, where: Doc) =>
    Object.entries(where).every(([key, value]) => doc[key] === value)

  function collection(name: string) {
    let where: Doc = {}
    let limit = 1000
    const api = {
      where(next: Doc) {
        where = next
        return api
      },
      limit(next: number) {
        limit = next
        return api
      },
      async get() {
        calls.push(`get:${name}`)
        return { data: store[name].filter((doc) => matches(doc, where)).slice(0, limit) }
      },
      async update({ data: patch }: { data: Doc }) {
        const matched = store[name].filter((doc) => matches(doc, where))
        for (const doc of matched) Object.assign(doc, patch)
        calls.push(`update:${name}`)
        return { stats: { updated: matched.length } }
      },
      async remove() {
        const matched = store[name].filter((doc) => matches(doc, where))
        const ids = new Set(matched.map((doc) => doc._id))
        // 原地删：替换数组会让外部持有的引用指向旧数组，断言就失灵了。
        for (let index = store[name].length - 1; index >= 0; index -= 1) {
          if (ids.has(store[name][index]._id)) store[name].splice(index, 1)
        }
        calls.push(`remove:${name}`)
        return { stats: { removed: matched.length } }
      },
    }
    return api
  }

  return {
    calls,
    db: { collection, serverDate: () => new Date('2026-09-11T10:00:00+08:00') },
    items: store.inventory_items,
    reminders: store.reminder_jobs,
  }
}

/** 业务错误码只在 error.code 上，断言统一走这里。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

function activeItem(overrides: Doc = {}) {
  return {
    _id: 'item-1',
    ownerId: OWNER,
    inventoryStatus: 'active',
    version: 3,
    quantity: 2,
    ...overrides,
  }
}

const RESTORE_INPUT = {
  name: '牛奶',
  quantity: 2,
  unit: '盒',
  category: 'food',
  storageLocation: '冷藏',
  expiryInputMode: 'direct',
  expiryDate: '2026-12-01',
  reminderLeadDays: 1,
  itemId: 'item-1',
  version: 3,
}

describe('inventory writes 去事务化', () => {
  it('标用完：写状态并把数量清零，同时取消待发提醒', async () => {
    const fake = createFakeDb({
      items: [activeItem()],
      reminders: [{ _id: 'item-1', ownerId: OWNER, status: 'scheduled' }],
    })
    const writes = createWriteService({ db: fake.db })

    await expect(writes.transition(OWNER, { itemId: 'item-1', version: 3 }, 'used_up')).resolves.toEqual({
      version: 4,
    })
    expect(fake.items[0]).toMatchObject({ inventoryStatus: 'used_up', version: 4, quantity: 0 })
    expect(fake.reminders[0]).toMatchObject({ status: 'cancelled' })
  })

  it('错误码不退化：已处理过的物品报 INVALID_STATE，不是 CONFLICT', async () => {
    const fake = createFakeDb({ items: [activeItem({ inventoryStatus: 'used_up' })] })
    const writes = createWriteService({ db: fake.db })
    // 去事务化最容易踩的坑就是把所有失败并成 CONFLICT，批量结果会全变成「刷新重试」。
    expect(await codeOf(writes.transition(OWNER, { itemId: 'item-1', version: 3 }, 'used_up'))).toBe(
      'INVALID_STATE',
    )
    expect(fake.items[0].inventoryStatus).toBe('used_up')
  })

  it('别人的物品一律 NOT_FOUND，且不会被改到', async () => {
    const fake = createFakeDb({ items: [activeItem({ ownerId: OTHER })] })
    const writes = createWriteService({ db: fake.db })
    expect(await codeOf(writes.moveToTrash(OWNER, { itemId: 'item-1', version: 3 }))).toBe('NOT_FOUND')
    expect(fake.items[0].inventoryStatus).toBe('active')
  })

  it('version 不匹配：报 CONFLICT 且一条都不写', async () => {
    const fake = createFakeDb({ items: [activeItem()] })
    const writes = createWriteService({ db: fake.db })
    expect(await codeOf(writes.moveToTrash(OWNER, { itemId: 'item-1', version: 2 }))).toBe('CONFLICT')
    // 乐观锁生效的关键：状态与 version 都在 where 里，读写之间被改过就写不进去。
    expect(fake.items[0]).toMatchObject({ inventoryStatus: 'active', version: 3 })
  })

  it('移入回收站：落 purgeAfter 并直接删掉提醒任务', async () => {
    const fake = createFakeDb({
      items: [activeItem()],
      reminders: [{ _id: 'item-1', ownerId: OWNER, status: 'scheduled' }],
    })
    const writes = createWriteService({ db: fake.db })
    await expect(writes.moveToTrash(OWNER, { itemId: 'item-1', version: 3 })).resolves.toEqual({
      version: 4,
    })
    expect(fake.items[0]).toMatchObject({ inventoryStatus: 'deleted', version: 4 })
    expect(fake.items[0].purgeAfter).toBeInstanceOf(Date)
    expect(fake.reminders).toHaveLength(0)
  })

  it('已删除的物品不能再删一次', async () => {
    const fake = createFakeDb({ items: [activeItem({ inventoryStatus: 'deleted' })] })
    const writes = createWriteService({ db: fake.db })
    expect(await codeOf(writes.moveToTrash(OWNER, { itemId: 'item-1', version: 3 }))).toBe('INVALID_STATE')
  })

  it('彻底删除：只认回收站里的物品，连提醒一起清掉', async () => {
    const fake = createFakeDb({
      items: [activeItem({ inventoryStatus: 'deleted' })],
      reminders: [{ _id: 'item-1', ownerId: OWNER, status: 'sent' }],
    })
    const writes = createWriteService({ db: fake.db })
    await expect(writes.removePermanently(OWNER, { itemId: 'item-1', version: 3 })).resolves.toEqual({
      deleted: true,
    })
    expect(fake.items).toHaveLength(0)
    expect(fake.reminders).toHaveLength(0)
  })

  it('彻底删除在库物品会被拒绝', async () => {
    const fake = createFakeDb({ items: [activeItem()] })
    const writes = createWriteService({ db: fake.db })
    expect(await codeOf(writes.removePermanently(OWNER, { itemId: 'item-1', version: 3 }))).toBe(
      'INVALID_STATE',
    )
    expect(fake.items).toHaveLength(1)
  })

  it('重新入库：状态回 active 并清掉删除痕迹', async () => {
    const fake = createFakeDb({
      items: [activeItem({ inventoryStatus: 'deleted', deletedAt: new Date(), purgeAfter: new Date() })],
      reminders: [{ _id: 'item-1', ownerId: OWNER, status: 'scheduled' }],
    })
    const writes = createWriteService({ db: fake.db })
    await expect(writes.restore(OWNER, { data: RESTORE_INPUT })).resolves.toMatchObject({
      itemId: 'item-1',
      version: 4,
    })
    expect(fake.items[0]).toMatchObject({
      inventoryStatus: 'active',
      version: 4,
      completedAt: null,
      deletedAt: null,
      purgeAfter: null,
    })
    expect(fake.reminders).toHaveLength(0)
  })

  it('重新入库不接受快速录入请求编号', async () => {
    const fake = createFakeDb({ items: [activeItem({ inventoryStatus: 'deleted' })] })
    const writes = createWriteService({ db: fake.db })
    expect(
      await codeOf(writes.restore(OWNER, { data: RESTORE_INPUT, idempotencyKey: 'x' })),
    ).toBe('INVALID_ARGUMENT')
  })

  it('没有提醒任务时静默跳过，不报错也不多写', async () => {
    const fake = createFakeDb({ items: [activeItem()] })
    const writes = createWriteService({ db: fake.db })
    await writes.transition(OWNER, { itemId: 'item-1', version: 3 }, 'used_up')
    expect(fake.calls).not.toContain('update:reminder_jobs')
    expect(fake.calls).not.toContain('remove:reminder_jobs')
  })

  it('已发送的提醒不会被取消成 cancelled', async () => {
    const fake = createFakeDb({
      items: [activeItem()],
      reminders: [{ _id: 'item-1', ownerId: OWNER, status: 'sent' }],
    })
    const writes = createWriteService({ db: fake.db })
    await writes.transition(OWNER, { itemId: 'item-1', version: 3 }, 'used_up')
    expect(fake.reminders[0].status).toBe('sent')
  })
})
