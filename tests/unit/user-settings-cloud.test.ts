import { describe, expect, it } from 'vitest'

const settingsModule = require('../../cloudfunctions/userApi/settings') as {
  createSettingsService(options: { db: unknown }): {
    getSettings(ownerId: string): Promise<{ defaultReminderLeadDays: number }>
    updateSettings(ownerId: string, input: unknown): Promise<{ defaultReminderLeadDays: number }>
  }
  validateSettings(input: unknown): { defaultReminderLeadDays: number }
}

type Doc = Record<string, unknown>

/** db.command.remove() 的替身：假库遇到它就删掉对应字段，而不是把哨兵写进文档。 */
const REMOVE_FIELD = Symbol('remove')

function createFakeDb(settings: Doc[] = []) {
  const store: Doc[] = settings.map((doc) => ({ ...doc }))
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
        return { data: store.filter((doc) => matches(doc, where)).slice(0, limit) }
      },
      async update({ data: patch }: { data: Doc }) {
        const matched = store.filter((doc) => matches(doc, where))
        for (const doc of matched) {
          for (const [key, value] of Object.entries(patch)) {
            if (value === REMOVE_FIELD) delete doc[key]
            else doc[key] = value
          }
        }
        calls.push(`update:${name}`)
        return { stats: { updated: matched.length } }
      },
      doc(id: string) {
        return {
          async set({ data: value }: { data: Doc }) {
            const index = store.findIndex((doc) => doc._id === id)
            const next = { ...value, _id: id }
            if (index >= 0) store[index] = next
            else store.push(next)
            calls.push(`set:${name}`)
            return {}
          },
        }
      },
    }
    return api
  }

  return {
    calls,
    db: {
      collection,
      command: { remove: () => REMOVE_FIELD },
      serverDate: () => new Date('2026-09-11T10:00:00+08:00'),
    },
    store,
  }
}

const OWNER = 'openid-1'
const OTHER = 'openid-2'

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

describe('userApi 设置校验', () => {
  it('默认提醒天数必须是 0～30 的整数', () => {
    expect(settingsModule.validateSettings({ defaultReminderLeadDays: 0 })).toEqual({
      defaultReminderLeadDays: 0,
    })
    expect(
      syncCodeOf(() => settingsModule.validateSettings({ defaultReminderLeadDays: 31 })),
    ).toBe('INVALID_ARGUMENT')
    expect(
      syncCodeOf(() => settingsModule.validateSettings({ defaultReminderLeadDays: 1.5 })),
    ).toBe('INVALID_ARGUMENT')
    expect(
      syncCodeOf(() => settingsModule.validateSettings({ defaultReminderLeadDays: '3' })),
    ).toBe('INVALID_ARGUMENT')
  })

  it('不认识的字段一律拒绝，防止客户端塞身份字段', () => {
    expect(syncCodeOf(() => settingsModule.validateSettings({ ownerId: 'x' }))).toBe(
      'FORBIDDEN_FIELD',
    )
    expect(syncCodeOf(() => settingsModule.validateSettings(null))).toBe('INVALID_ARGUMENT')
  })
})

describe('userApi getSettings', () => {
  it('没有设置文档时回落默认 1 天', async () => {
    const fake = createFakeDb()
    const service = settingsModule.createSettingsService({ db: fake.db })
    await expect(service.getSettings(OWNER)).resolves.toEqual({ defaultReminderLeadDays: 1 })
    expect(fake.calls).toEqual(['get:user_settings'])
  })

  it('只读本人的设置，不再顺带 count 一次提醒任务', async () => {
    const fake = createFakeDb([
      { _id: OTHER, ownerId: OTHER, defaultReminderLeadDays: 9 },
      { _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 5 },
    ])
    const service = settingsModule.createSettingsService({ db: fake.db })
    await expect(service.getSettings(OWNER)).resolves.toEqual({ defaultReminderLeadDays: 5 })
    // 一次查询就够：hasReminderJobs 全项目没人用，那次 count 已经删掉。
    expect(fake.calls).toEqual(['get:user_settings'])
  })
})

describe('userApi updateSettings', () => {
  it('已有文档走条件更新，不再先读一次', async () => {
    const fake = createFakeDb([
      { _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 1, defaultStorageLocation: 'cabinet' },
    ])
    const service = settingsModule.createSettingsService({ db: fake.db })
    await expect(service.updateSettings(OWNER, { defaultReminderLeadDays: 7 })).resolves.toEqual({
      defaultReminderLeadDays: 7,
    })
    expect(fake.calls).toEqual(['update:user_settings'])
    expect(fake.store[0]).toMatchObject({ defaultReminderLeadDays: 7 })
    // 废弃字段在更新时清掉，不留垃圾。
    expect(fake.store[0].defaultStorageLocation).toBeUndefined()
  })

  it('没有文档时补建，不会把更新丢掉', async () => {
    const fake = createFakeDb()
    const service = settingsModule.createSettingsService({ db: fake.db })
    await expect(service.updateSettings(OWNER, { defaultReminderLeadDays: 3 })).resolves.toEqual({
      defaultReminderLeadDays: 3,
    })
    expect(fake.calls).toEqual(['update:user_settings', 'set:user_settings'])
    expect(fake.store).toHaveLength(1)
    expect(fake.store[0]).toMatchObject({ _id: OWNER, ownerId: OWNER, defaultReminderLeadDays: 3 })
  })

  it('别人的设置文档不会被改到', async () => {
    const fake = createFakeDb([{ _id: OTHER, ownerId: OTHER, defaultReminderLeadDays: 9 }])
    const service = settingsModule.createSettingsService({ db: fake.db })
    await service.updateSettings(OWNER, { defaultReminderLeadDays: 2 })
    expect(fake.store[0]).toMatchObject({ _id: OTHER, defaultReminderLeadDays: 9 })
    expect(fake.store).toHaveLength(2)
  })
})
