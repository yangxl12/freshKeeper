import { describe, expect, it } from 'vitest'

const validation = require('../../cloudfunctions/userApi/validation') as {
  avatarCloudPath(hash: string, ext: string, now?: number, id?: string): string
  avatarOwnerHash(ownerId: string): string
  exportFileName(now?: Date): string
  normalizeNickname(value: unknown): string | null
}

const { buildExportPayload } = require('../../cloudfunctions/userApi/export') as {
  buildExportPayload(input: Record<string, unknown>): Record<string, any>
}

const account = require('../../cloudfunctions/userApi/account') as {
  createAccountService(options: {
    db: any
    deleteFile: (input: { fileList: string[] }) => Promise<{ fileList?: Array<{ fileID: string; status: number }> }>
    uploadFile?: (input: { cloudPath: string; fileContent: unknown }) => Promise<{ fileID: string }>
  }): {
    createAvatarUpload(ownerId: string, input?: unknown): { cloudPath: string }
    deleteAccount(ownerId: string, input: unknown): Promise<{ deleted: Record<string, number> }>
    exportData(ownerId: string, now?: Date): Promise<{ fileID: string; fileName: string }>
    updateProfile(ownerId: string, input: unknown): Promise<Record<string, unknown>>
  }
}

const OWNER = 'openid-1'
const OTHER = 'openid-2'

type Doc = Record<string, unknown>

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

function createFakeDb(options: {
  users?: Doc[]
  items?: Doc[]
  reminders?: Doc[]
  settings?: Doc[]
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
        // 返回副本：真实 db 读出来的是快照，改库不会反过来改掉已经读出来的对象。
        return { data: matched.slice(skip, skip + limit).map((doc) => ({ ...doc })) }
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
        store[name] = store[name].filter((doc) => !ids.has(doc._id))
        calls.push(`remove:${name}`)
        return { stats: { removed: matched.length } }
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

  return { db: { collection, serverDate: () => new Date('2026-09-11T10:00:00+08:00') }, calls, store }
}

function noopDeleteFile(calls: string[] = []) {
  return async ({ fileList }: { fileList: string[] }) => {
    calls.push(`deleteFile:${fileList.join(',')}`)
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  }
}

describe('normalizeNickname（码点截断）', () => {
  it('trim 后按码点截断，emoji 不会被切坏', () => {
    expect(validation.normalizeNickname('  龙哥  ')).toBe('龙哥')
    expect(validation.normalizeNickname('')).toBeNull()
    expect(validation.normalizeNickname('    ')).toBeNull()
    expect(validation.normalizeNickname(null)).toBeNull()
    expect(Array.from(String(validation.normalizeNickname('😀'.repeat(25))))).toHaveLength(20)
  })

  it('恰好 20 个码点原样保留', () => {
    const value = 'a'.repeat(20)
    expect(validation.normalizeNickname(value)).toBe(value)
  })
})

describe('avatarCloudPath', () => {
  it('落在本人哈希目录下', () => {
    const hash = validation.avatarOwnerHash(OWNER)
    expect(validation.avatarCloudPath(hash, 'png', 1700000000000, 'id-1')).toBe(
      `avatars/${hash}/1700000000000-id-1.png`,
    )
  })

  it('扩展名白名单之外的统一按 png', () => {
    const hash = validation.avatarOwnerHash(OWNER)
    expect(validation.avatarCloudPath(hash, 'JPG', 1, 'i')).toMatch(/\.jpg$/)
    expect(validation.avatarCloudPath(hash, 'exe', 1, 'i')).toMatch(/\.png$/)
    expect(validation.avatarCloudPath(hash, '', 1, 'i')).toMatch(/\.png$/)
  })

  it('哈希不泄露明文 openid', () => {
    expect(validation.avatarOwnerHash(OWNER)).not.toContain(OWNER)
    expect(validation.avatarOwnerHash(OWNER)).toHaveLength(32)
    expect(validation.avatarOwnerHash(OWNER)).not.toBe(validation.avatarOwnerHash(OTHER))
  })
})

describe('createAvatarUpload', () => {
  it('返回本人目录下的 cloudPath', () => {
    const fake = createFakeDb()
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile() })
    const { cloudPath } = service.createAvatarUpload(OWNER, { ext: 'jpeg' })
    expect(cloudPath.startsWith(`avatars/${validation.avatarOwnerHash(OWNER)}/`)).toBe(true)
    expect(cloudPath.endsWith('.jpeg')).toBe(true)
  })

  it('不传 data 也能出路径', () => {
    const fake = createFakeDb()
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile() })
    expect(service.createAvatarUpload(OWNER).cloudPath).toMatch(/^avatars\/.+\.png$/)
  })
})

describe('updateProfile 换头像时清理旧图', () => {
  const oldAvatar = `cloud://env.1/avatars/${validation.avatarOwnerHash(OWNER)}/old.png`
  const newAvatar = `cloud://env.1/avatars/${validation.avatarOwnerHash(OWNER)}/new.png`

  function build() {
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, nickname: null, avatarFileId: oldAvatar, schemaVersion: 1 }],
    })
    const calls: string[] = []
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile(calls) })
    return { fake, calls, service }
  }

  it('换图后删掉旧头像', async () => {
    const { fake, calls, service } = build()
    await expect(service.updateProfile(OWNER, { avatarFileId: newAvatar })).resolves.toMatchObject({
      avatarFileId: newAvatar,
    })
    expect(calls).toContain(`deleteFile:${oldAvatar}`)
    expect(fake.store.users[0].avatarFileId).toBe(newAvatar)
  })

  it('删旧图失败不影响更新结果（fire-and-forget）', async () => {
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, nickname: null, avatarFileId: oldAvatar, schemaVersion: 1 }],
    })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: async () => {
        throw new Error('storage down')
      },
    })
    await expect(service.updateProfile(OWNER, { avatarFileId: newAvatar })).resolves.toMatchObject({
      avatarFileId: newAvatar,
    })
  })

  it('旧头像为空或没换图时不触发删除', async () => {
    const fake = createFakeDb({ users: [{ _id: OWNER, ownerId: OWNER, avatarFileId: null, schemaVersion: 1 }] })
    const calls: string[] = []
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile(calls) })
    await service.updateProfile(OWNER, { avatarFileId: newAvatar })
    expect(calls).toEqual([])

    const second = createFakeDb({ users: [{ _id: OWNER, ownerId: OWNER, avatarFileId: newAvatar, schemaVersion: 1 }] })
    const secondCalls: string[] = []
    const secondService = account.createAccountService({
      db: second.db,
      deleteFile: noopDeleteFile(secondCalls),
    })
    await secondService.updateProfile(OWNER, { avatarFileId: newAvatar })
    expect(secondCalls).toEqual([])
  })

  it('别人的头像挂不上来', async () => {
    const { service } = build()
    const others = `cloud://env.1/avatars/${validation.avatarOwnerHash(OTHER)}/x.png`
    expect(await codeOf(service.updateProfile(OWNER, { avatarFileId: others }))).toBe('INVALID_ARGUMENT')
  })
})

describe('buildExportPayload', () => {
  const items = [
    {
      _id: 'i1',
      ownerId: OWNER,
      name: '牛奶',
      coverFileId: 'cloud://env.1/covers/x.png',
      inventoryStatus: 'active',
      expiryDate: '2026-09-20',
    },
  ]
  const reminders = [{ _id: 'r1', ownerId: OWNER, templateId: 'TPL', remindAt: '2026-09-18', status: 'scheduled' }]
  const user = { _id: OWNER, ownerId: OWNER, nickname: '龙哥', createdAt: new Date('2026-09-01T10:00:00+08:00') }

  it('快照结构稳定，且不含任何标识字段', () => {
    const payload = buildExportPayload({
      items,
      settings: { _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 3 },
      user,
      reminders,
      exportedAt: '2026-09-11',
    })
    expect(payload.schemaVersion).toBe(1)
    expect(payload.exportedAt).toBe('2026-09-11')

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(OWNER)
    expect(serialized).not.toContain('templateId')
    expect(serialized).not.toContain('TPL')
    expect(payload.items[0]).not.toHaveProperty('_id')
    expect(payload.items[0]).not.toHaveProperty('ownerId')
    expect(payload.settings).toEqual({ defaultReminderLeadDays: 3 })
    expect(payload.profile).toEqual({ nickname: '龙哥', createdAt: '2026-09-01', lastSeenAt: null })
  })

  it('缺数据时给空壳而不是报错', () => {
    const payload = buildExportPayload({})
    expect(payload).toEqual({
      schemaVersion: 1,
      exportedAt: '',
      profile: { nickname: null, createdAt: null, lastSeenAt: null },
      settings: { defaultReminderLeadDays: null },
      items: [],
      reminders: [],
    })
  })

  it('提醒只带时间与状态，不带模板 ID', () => {
    const payload = buildExportPayload({ reminders })
    expect(payload.reminders[0]).toEqual({
      remindAt: '2026-09-18',
      status: 'scheduled',
      createdAt: null,
      inventoryItemId: null,
    })
  })
})

describe('exportData', () => {
  function build(options: { users?: Doc[]; items?: Doc[] } = {}, uploadImpl?: any) {
    const fake = createFakeDb({
      users: options.users ?? [{ _id: OWNER, ownerId: OWNER, nickname: '龙哥', schemaVersion: 1 }],
      items: options.items ?? [{ _id: 'i1', ownerId: OWNER, name: '牛奶' }],
      reminders: [{ _id: 'r1', ownerId: OWNER, templateId: 'TPL', status: 'scheduled' }],
      settings: [{ _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 1 }],
    })
    const uploads: Array<{ cloudPath: string; content: string }> = []
    const uploadFile =
      uploadImpl ??
      (async (input: { cloudPath: string; fileContent: Buffer }) => {
        uploads.push({ cloudPath: input.cloudPath, content: input.fileContent.toString('utf8') })
        return { fileID: `cloud://env.1/${input.cloudPath}` }
      })
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: noopDeleteFile(),
      uploadFile,
    })
    return { fake, uploads, service }
  }

  it('上传导出文件并记录导出痕迹', async () => {
    const { fake, uploads, service } = build()
    const result = await service.exportData(OWNER, new Date('2026-09-11T10:00:00+08:00'))

    expect(result.fileName).toBe('保质记-数据导出-20260911-1000.txt')
    expect(result.fileID).toContain(`exports/${validation.avatarOwnerHash(OWNER)}/`)
    expect(uploads).toHaveLength(1)
    expect(uploads[0].cloudPath.endsWith('.txt')).toBe(true)

    const payload = JSON.parse(uploads[0].content)
    expect(payload.items).toHaveLength(1)
    expect(payload.profile.nickname).toBe('龙哥')
    expect(fake.store.users[0]).toMatchObject({ exportCountDate: '2026-09-11', exportCount: 1 })
    expect(fake.store.users[0].lastExportedAt).toBeInstanceOf(Date)
  })

  it('每日限次，计数按上海日期滚动', async () => {
    const { service } = build({
      users: [
        {
          _id: OWNER,
          ownerId: OWNER,
          exportCountDate: '2026-09-11',
          exportCount: 3,
          schemaVersion: 1,
        },
      ],
    })
    expect(await codeOf(service.exportData(OWNER, new Date('2026-09-11T20:00:00+08:00')))).toBe(
      'EXPORT_LIMIT_EXCEEDED',
    )
  })

  it('跨天后计数重新开始', async () => {
    const { fake, service } = build({
      users: [{ _id: OWNER, ownerId: OWNER, exportCountDate: '2026-09-10', exportCount: 3, schemaVersion: 1 }],
    })
    await service.exportData(OWNER, new Date('2026-09-11T10:00:00+08:00'))
    expect(fake.store.users[0]).toMatchObject({ exportCountDate: '2026-09-11', exportCount: 1 })
  })

  it('上传失败时抛错，不写导出记录', async () => {
    const { fake, service } = build({}, async () => {
      throw new Error('upload down')
    })
    await expect(service.exportData(OWNER, new Date('2026-09-11T10:00:00+08:00'))).rejects.toThrow(
      'upload down',
    )
    expect(fake.store.users[0].lastExportedAt).toBeUndefined()
  })

  it('没有 uploadFile 能力时直接报错，不静默成功', async () => {
    const fake = createFakeDb({ users: [{ _id: OWNER, ownerId: OWNER, schemaVersion: 1 }] })
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile() })
    expect(await codeOf(service.exportData(OWNER, new Date()))).toBe('INTERNAL_ERROR')
  })

  it('导出只带自己的数据', async () => {
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, schemaVersion: 1 }],
      items: [
        { _id: 'i1', ownerId: OWNER, name: '牛奶' },
        { _id: 'i2', ownerId: OTHER, name: '别人的东西' },
      ],
    })
    let content = ''
    const service = account.createAccountService({
      db: fake.db,
      deleteFile: noopDeleteFile(),
      uploadFile: async (input: { fileContent: Buffer }) => {
        content = input.fileContent.toString('utf8')
        return { fileID: 'cloud://env.1/exports/x.txt' }
      },
    })
    await service.exportData(OWNER, new Date('2026-09-11T10:00:00+08:00'))
    expect(JSON.parse(content).items).toEqual([{ name: '牛奶' }])
  })
})

describe('deleteAccount 连带清头像', () => {
  it('头像 fileID 也被收集进删除列表', async () => {
    const avatar = `cloud://env.1/avatars/${validation.avatarOwnerHash(OWNER)}/me.png`
    const fake = createFakeDb({
      users: [{ _id: OWNER, ownerId: OWNER, avatarFileId: avatar, schemaVersion: 1 }],
      items: [{ _id: 'i1', ownerId: OWNER, coverFileId: 'cloud://env.1/covers/1.png' }],
    })
    const calls: string[] = []
    const service = account.createAccountService({ db: fake.db, deleteFile: noopDeleteFile(calls) })
    const result = await service.deleteAccount(OWNER, { confirm: 'DELETE' })
    expect(result.deleted.files).toBe(2)
    expect(calls[0]).toContain(avatar)
  })
})
