import { describe, expect, it } from 'vitest'

const date = require('../../cloudfunctions/userApi/date') as {
  currentDateKey(now?: Date): string
  shanghaiDateKey(value: unknown): string
  shouldTouchToday(lastSeenAt: unknown, today: string): boolean
}

const validation = require('../../cloudfunctions/userApi/validation') as {
  avatarOwnerPrefix(ownerId: string): string
  validateDeleteConfirm(input: unknown): void
  validateProfileUpdate(input: unknown, ownerId: string): Record<string, unknown>
}

const account = require('../../cloudfunctions/userApi/account') as {
  chunk<T>(list: T[], size: number): T[][]
  createAccountService(options: {
    db: unknown
    deleteFile: (input: { fileList: string[] }) => Promise<{ fileList?: Array<{ fileID: string; status: number }> }>
  }): {
    deleteAccount(ownerId: string, input: unknown): Promise<{ deleted: Record<string, number> }>
    getProfile(ownerId: string): Promise<Record<string, unknown>>
    touch(ownerId: string, now?: Date): Promise<{ created: boolean; lastSeenAt: string }>
    updateProfile(ownerId: string, input: unknown): Promise<Record<string, unknown>>
  }
}

type Doc = Record<string, unknown>

/** 业务错误码不体现在 message 里，统一从 code 断言。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

function syncCodeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

/** 假 db：只实现 userApi 用到的查询形态，并记录调用顺序与次数。 */
function createFakeDb(options: {
  users?: Doc[]
  items?: Doc[]
  reminders?: Doc[]
  settings?: Doc[]
  removeCap?: number
} = {}) {
  const store: Record<string, Doc[]> = {
    users: [...(options.users ?? [])],
    inventory_items: [...(options.items ?? [])],
    reminder_jobs: [...(options.reminders ?? [])],
    user_settings: [...(options.settings ?? [])],
  }
  const calls: string[] = []

  const matches = (doc: Doc, where: Doc) =>
    Object.entries(where).every(([key, value]) => doc[key] === value)

  function collection(name: string) {
    let where: Doc = {}
    let skip = 0
    let limit = 1000
    const api = {
      where(next: Doc) {
        where = next
        return api
      },
      skip(next: number) {
        skip = next
        return api
      },
      limit(next: number) {
        limit = next
        return api
      },
      async get() {
        const matched = store[name].filter((doc) => matches(doc, where))
        return { data: matched.slice(skip, skip + limit) }
      },
      async update({ data: patch }: { data: Doc }) {
        const matched = store[name].filter((doc) => matches(doc, where))
        for (const doc of matched) Object.assign(doc, patch)
        calls.push(`update:${name}`)
        return { stats: { updated: matched.length } }
      },
      async remove() {
        const matched = store[name].filter((doc) => matches(doc, where))
        const batch = options.removeCap ? matched.slice(0, options.removeCap) : matched
        const ids = new Set(batch.map((doc) => doc._id))
        store[name] = store[name].filter((doc) => !ids.has(doc._id))
        calls.push(`remove:${name}`)
        return { stats: { removed: batch.length } }
      },
      doc(id: string) {
        return {
          async set({ data: value }: { data: Doc }) {
            store[name] = store[name].filter((doc) => doc._id !== id)
            store[name].push({ ...value, _id: id })
            calls.push(`set:${name}`)
            return {}
          },
        }
      },
    }
    return api
  }

  return {
    db: { collection, serverDate: () => new Date('2026-09-11T10:00:00+08:00') },
    calls,
    store,
  }
}

function createFakeDeleteFile(calls: string[]) {
  const batches: string[][] = []
  const deleteFile = async ({ fileList }: { fileList: string[] }) => {
    batches.push([...fileList])
    calls.push('deleteFile')
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  }
  return { deleteFile, batches }
}

const OWNER = 'openid-1'
const OTHER = 'openid-2'

describe('userApi 日期判定', () => {
  it('按上海时区归一日期串', () => {
    expect(date.shanghaiDateKey(new Date('2026-09-10T16:30:00Z'))).toBe('2026-09-11')
    expect(date.shanghaiDateKey('2026-09-11T00:00:00+08:00')).toBe('2026-09-11')
    expect(date.shanghaiDateKey(new Date('2026-09-11T00:00:00+08:00').getTime())).toBe('2026-09-11')
  })

  it('异常值归为空串，不抛错', () => {
    expect(date.shanghaiDateKey(undefined)).toBe('')
    expect(date.shanghaiDateKey(null)).toBe('')
    expect(date.shanghaiDateKey('not-a-date')).toBe('')
  })

  it('只有跨天或没有记录时才需要写 lastSeenAt', () => {
    expect(date.shouldTouchToday(null, '2026-09-11')).toBe(true)
    expect(date.shouldTouchToday('2026-09-11', '2026-09-11')).toBe(false)
    expect(date.shouldTouchToday('2026-09-10', '2026-09-11')).toBe(true)
    // 跨时区边界：UTC 09-10T16:30 已经是上海 09-11，不该再写一次。
    expect(date.shouldTouchToday(new Date('2026-09-10T16:30:00Z'), '2026-09-11')).toBe(false)
    expect(date.shouldTouchToday('not-a-date', '2026-09-11')).toBe(true)
  })

  it('currentDateKey 按传入时刻取上海日期', () => {
    expect(date.currentDateKey(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01-01')
  })
})

describe('userApi chunk', () => {
  it('按批大小切分，保留顺序', () => {
    expect(account.chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(account.chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    expect(account.chunk([], 50)).toEqual([])
  })

  it('批大小非法时退化为逐个处理，绝不死循环', () => {
    expect(account.chunk([1, 2], 0)).toEqual([[1], [2]])
  })
})

describe('userApi touch', () => {
  it('首次 touch 建档案并标记 created', async () => {
    const fake = createFakeDb()
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })

    const result = await service.touch(OWNER, new Date('2026-09-11T10:00:00+08:00'))
    expect(result).toEqual({ created: true, lastSeenAt: '2026-09-11' })
    expect(fake.store.users).toHaveLength(1)
    expect(fake.store.users[0]).toMatchObject({
      _id: OWNER,
      ownerId: OWNER,
      nickname: null,
      avatarFileId: null,
      schemaVersion: 1,
    })
  })

  it('同一天二次 touch 不写库（服务端兜底）', async () => {
    const now = new Date('2026-09-11T10:00:00+08:00')
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, lastSeenAt: now, createdAt: now, schemaVersion: 1 }],
    })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })

    const result = await service.touch(OWNER, new Date('2026-09-11T22:00:00+08:00'))
    expect(result).toEqual({ created: false, lastSeenAt: '2026-09-11' })
    expect(fake.calls).toEqual([])
  })

  it('跨天 touch 更新 lastSeenAt 且不重建档案', async () => {
    const yesterday = new Date('2026-09-10T10:00:00+08:00')
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, lastSeenAt: yesterday, createdAt: yesterday, schemaVersion: 1 }],
    })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })

    const result = await service.touch(OWNER, new Date('2026-09-11T10:00:00+08:00'))
    expect(result).toEqual({ created: false, lastSeenAt: '2026-09-11' })
    expect(fake.calls).toEqual(['update:users'])
    expect(fake.store.users).toHaveLength(1)
  })

  it('别人的档案不会被读到，也不会被覆盖', async () => {
    const now = new Date('2026-09-11T10:00:00+08:00')
    const fake = createFakeDb({
      users: [{ _id: OTHER, ownerId: OTHER, lastSeenAt: now, createdAt: now, schemaVersion: 1 }],
    })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })
    await expect(service.touch(OWNER, now)).resolves.toMatchObject({ created: true })
    expect(fake.store.users).toHaveLength(2)
  })
})

describe('userApi getProfile', () => {
  it('没有档案时返回全空，不报错', async () => {
    const fake = createFakeDb()
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })
    await expect(service.getProfile(OWNER)).resolves.toEqual({
      nickname: null,
      avatarFileId: null,
      createdAt: null,
      lastSeenAt: null,
    })
  })

  it('日期一律归一为上海日期串', async () => {
    const fake = createFakeDb({
      users: [
        {
          _id: OWNER,
          ownerId: OWNER,
          nickname: '龙哥',
          avatarFileId: null,
          createdAt: new Date('2026-09-01T10:00:00+08:00'),
          lastSeenAt: new Date('2026-09-10T16:30:00Z'),
        },
      ],
    })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })
    await expect(service.getProfile(OWNER)).resolves.toEqual({
      nickname: '龙哥',
      avatarFileId: null,
      createdAt: '2026-09-01',
      lastSeenAt: '2026-09-11',
    })
  })
})

describe('userApi updateProfile 校验', () => {
  it('只允许 nickname / avatarFileId', () => {
    expect(syncCodeOf(() => validation.validateProfileUpdate({ nickname: 'a', ownerId: 'x' }, OWNER))).toBe(
      'FORBIDDEN_FIELD',
    )
    expect(syncCodeOf(() => validation.validateProfileUpdate({}, OWNER))).toBe('INVALID_ARGUMENT')
  })

  it('昵称去空格，超出 20 字直接拒绝', () => {
    expect(validation.validateProfileUpdate({ nickname: ' 龙哥 ' }, OWNER)).toEqual({ nickname: '龙哥' })
    expect(syncCodeOf(() => validation.validateProfileUpdate({ nickname: '长'.repeat(21) }, OWNER))).toBe(
      'INVALID_ARGUMENT',
    )
  })

  it('头像必须是本人前缀下的 cloud:// 文件', () => {
    const prefix = validation.avatarOwnerPrefix(OWNER)
    const mine = `cloud://env.1/${prefix}a.png`
    expect(validation.validateProfileUpdate({ avatarFileId: mine }, OWNER)).toEqual({
      avatarFileId: mine,
    })
    expect(syncCodeOf(() => validation.validateProfileUpdate({ avatarFileId: 'https://x/a.png' }, OWNER))).toBe(
      'INVALID_ARGUMENT',
    )
    expect(
      syncCodeOf(() =>
        validation.validateProfileUpdate(
          { avatarFileId: `cloud://env.1/${validation.avatarOwnerPrefix(OTHER)}a.png` },
          OWNER,
        ),
      ),
    ).toBe('INVALID_ARGUMENT')
    expect(
      syncCodeOf(() =>
        validation.validateProfileUpdate({ avatarFileId: `cloud://env.1/${prefix}../a.png` }, OWNER),
      ),
    ).toBe('INVALID_ARGUMENT')
  })

  it('档案缺失时先建后写', async () => {
    const fake = createFakeDb()
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: createFakeDeleteFile(fake.calls).deleteFile,
    })
    await expect(service.updateProfile(OWNER, { nickname: '龙哥' })).resolves.toMatchObject({
      nickname: '龙哥',
    })
    expect(fake.store.users).toHaveLength(1)
  })

  it('注销确认词不对一律拒绝', () => {
    expect(validation.validateDeleteConfirm({ confirm: 'DELETE' })).toBeUndefined()
    expect(syncCodeOf(() => validation.validateDeleteConfirm({ confirm: 'delete' }))).toBe(
      'INVALID_ARGUMENT',
    )
    expect(syncCodeOf(() => validation.validateDeleteConfirm({}))).toBe('INVALID_ARGUMENT')
  })
})

describe('userApi deleteAccount', () => {
  function build(itemCount: number, withCovers = true, removeCap?: number) {
    const items = Array.from({ length: itemCount }, (_unused, index) => ({
      _id: `item-${index}`,
      ownerId: OWNER,
      coverFileId: withCovers ? `cloud://env.1/covers/abcd/item-${index}.png` : null,
    }))
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, lastSeenAt: new Date(), schemaVersion: 1 }],
      items,
      reminders: [{ _id: 'r1', ownerId: OWNER }],
      settings: [{ _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 1 }],
      removeCap,
    })
    const files = createFakeDeleteFile(fake.calls)
    const service = account.createAccountService({ db: fake.db, deleteFile: files.deleteFile })
    return { fake, files, service }
  }

  it('confirm 不对直接拒绝（服务端二次把关）', async () => {
    const { service } = build(1)
    expect(await codeOf(service.deleteAccount(OWNER, { confirm: 'delete' }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(service.deleteAccount(OWNER, {}))).toBe('INVALID_ARGUMENT')
  })

  it('先收集 fileID → 删云存储 → 最后删数据库', async () => {
    const { fake, files, service } = build(3)
    const result = await service.deleteAccount(OWNER, { confirm: 'DELETE' })

    expect(result.deleted).toEqual({ items: 3, reminders: 1, settings: 1, files: 3 })
    // 顺序是硬要求：删了库就再也读不到 coverFileId 了。
    expect(files.batches).toHaveLength(1)
    expect(fake.calls.lastIndexOf('deleteFile')).toBeGreaterThanOrEqual(0)
    expect(fake.calls.indexOf('remove:inventory_items')).toBeGreaterThan(
      fake.calls.lastIndexOf('deleteFile'),
    )
    expect(fake.store.inventory_items).toHaveLength(0)
    expect(fake.store.reminder_jobs).toHaveLength(0)
    expect(fake.store.user_settings).toHaveLength(0)
    // users 也要删干净：注销后重新进入是全新账号。
    expect(fake.store.users).toHaveLength(0)
  })

  it('fileID 按 50 一批删', async () => {
    const { files, service } = build(120)
    const result = await service.deleteAccount(OWNER, { confirm: 'DELETE' })
    expect(files.batches.map((batch) => batch.length)).toEqual([50, 50, 20])
    expect(result.deleted.files).toBe(120)
    expect(result.deleted.items).toBe(120)
  })

  it('没有封面图时不调删除存储', async () => {
    const { files, service } = build(2, false)
    const result = await service.deleteAccount(OWNER, { confirm: 'DELETE' })
    expect(files.batches).toEqual([])
    expect(result.deleted.files).toBe(0)
    expect(result.deleted.items).toBe(2)
  })

  it('只剩别人的数据，一条都不动', async () => {
    const fake = createFakeDb({
      users: [{ _id: OTHER, ownerId: OTHER, schemaVersion: 1 }],
      items: [{ _id: 'item-other', ownerId: OTHER, coverFileId: 'cloud://env.1/covers/x.png' }],
      reminders: [{ _id: 'r-other', ownerId: OTHER }],
      settings: [{ _id: OTHER, ownerId: OTHER }],
    })
    const files = createFakeDeleteFile(fake.calls)
    const service = account.createAccountService({ db: fake.db, deleteFile: files.deleteFile })

    const result = await service.deleteAccount(OWNER, { confirm: 'DELETE' })
    expect(result.deleted).toEqual({ items: 0, reminders: 0, settings: 0, files: 0 })
    expect(fake.store.inventory_items).toHaveLength(1)
    expect(fake.store.users).toHaveLength(1)
  })

  it('删干净后再调一次是空删（幂等）', async () => {
    const { service } = build(2)
    await service.deleteAccount(OWNER, { confirm: 'DELETE' })
    await expect(service.deleteAccount(OWNER, { confirm: 'DELETE' })).resolves.toEqual({
      deleted: { items: 0, reminders: 0, settings: 0, files: 0 },
    })
  })

  it('超过最大轮次直接报错让用户重试', async () => {
    const { service } = build(210, false, 10)
    expect(await codeOf(service.deleteAccount(OWNER, { confirm: 'DELETE' }))).toBe('DELETE_INCOMPLETE')
  })
})
