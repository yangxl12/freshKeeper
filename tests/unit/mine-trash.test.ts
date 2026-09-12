import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryItem } from '../../miniprogram/types/inventory'

const { getSettingsMock, listTrashMock, permanentlyDeleteItemMock, readReminderAuthorizationMock } = vi.hoisted(
  () => ({
    getSettingsMock: vi.fn(),
    listTrashMock: vi.fn(),
    permanentlyDeleteItemMock: vi.fn(),
    readReminderAuthorizationMock: vi.fn(),
  }),
)

vi.mock('../../miniprogram/services/inventory-service', () => ({
  listTrash: listTrashMock,
  permanentlyDeleteItem: permanentlyDeleteItemMock,
}))
vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
  updateSettings: vi.fn(),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  readReminderAuthorization: readReminderAuthorizationMock,
}))
vi.mock('../../miniprogram/services/user-service', () => ({
  confirmExport: vi.fn(),
  deleteAccount: vi.fn(),
  discardLocalExport: vi.fn(),
  getUserProfile: vi.fn(),
  prepareExport: vi.fn(),
  sharePreparedExport: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatarFile: vi.fn(),
}))

const originalPage = globalThis.Page
const originalWx = globalThis.wx
const originalGetApp = (globalThis as { getApp?: unknown }).getApp

let minePage: Record<string, any>
let app: { globalData: { pendingBatchIntent: unknown } }
let navigateToCalls: string[]

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    minePage = definition
  }) as never
  await import('../../miniprogram/pages/mine/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
  ;(globalThis as { getApp?: unknown }).getApp = originalGetApp
})

function instance() {
  const page: any = { ...minePage, data: structuredClone(minePage.data) }
  page.setData = (patch: object, callback?: () => void) => {
    Object.assign(page.data, patch)
    callback?.()
  }
  return page
}

function stubWx() {
  navigateToCalls = []
  globalThis.wx = {
    showToast: vi.fn(),
    showModal: vi.fn(() => Promise.resolve({ confirm: false })),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
    clearStorageSync: vi.fn(),
    reLaunch: vi.fn(),
    navigateTo: vi.fn((options: { url: string }) => {
      navigateToCalls.push(options.url)
    }),
    getStorageSync: () => '',
    setStorageSync: vi.fn(),
  } as never
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function item(id: string): InventoryItem {
  return {
    _id: id,
    name: `物品${id}`,
    quantity: 1,
    unit: '盒',
    category: 'food',
    storageLocation: '冰箱',
    expiryInputMode: 'direct',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: '2026-12-31',
    reminderLeadDays: 1,
    inventoryStatus: 'deleted',
    version: 1,
    completedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: '2026-09-01T00:00:00.000Z',
    purgeAfter: '2026-10-01T00:00:00.000Z',
    purgeDateText: '2026-10-01',
    expiryStatus: 'safe',
    daysLeft: 111,
    expiryStatusText: '状态良好',
    expiryTone: 'safe',
    categoryLabel: '食品',
    storageLabel: '冰箱',
    inventoryStatusLabel: '已删除',
  }
}

function trashResult(items: InventoryItem[]) {
  return { items, nextCursor: null, serverToday: '2026-09-11' }
}

beforeEach(() => {
  vi.clearAllMocks()
  stubWx()
  app = { globalData: { pendingBatchIntent: null } }
  ;(globalThis as { getApp?: unknown }).getApp = () => app
  listTrashMock.mockResolvedValue(trashResult([]))
  getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1, hasReminderJobs: false })
  readReminderAuthorizationMock.mockResolvedValue({ authorized: false, summary: '未授权' })
})

describe('我的 → 回收站批量管理入口', () => {
  it('带上当前搜索词和 source=trash 跳到批量操作页', () => {
    const page = instance()
    page.setData({ trashItems: [item('a')], trashSearch: '牛奶' })

    page.openTrashBatch()

    expect(app.globalData.pendingBatchIntent).toEqual({ source: 'trash', search: '牛奶' })
    expect(navigateToCalls).toEqual(['/pages/batch-operation/index?source=trash'])
  })

  it('回收站为空时不跳转，避免进到一个空列表', () => {
    const page = instance()
    page.setData({ trashItems: [] })

    page.openTrashBatch()

    expect(app.globalData.pendingBatchIntent).toBeNull()
    expect(navigateToCalls).toEqual([])
  })

  it('回收站加载中不跳转，防止带过去半截列表', () => {
    const page = instance()
    page.setData({ trashItems: [item('a')], trashLoading: true })

    page.openTrashBatch()

    expect(navigateToCalls).toEqual([])
  })
})

describe('我的 → 从批量管理返回后刷新回收站', () => {
  it('回收站还开着时 onShow 重新拉取，不带旧的半截数据', async () => {
    const page = instance()
    page.setData({ activeModal: 'trash', trashItems: [item('stale')], trashSearch: '' })
    listTrashMock.mockResolvedValue(trashResult([item('fresh')]))

    page.onShow()
    await flush()

    expect(listTrashMock).toHaveBeenCalledWith({ search: '', cursor: null })
    expect(page.data.trashItems.map((entry: { _id: string }) => entry._id)).toEqual(['fresh'])
  })

  it('回收站没打开时 onShow 不去读回收站', async () => {
    const page = instance()
    page.setData({ activeModal: '' })

    page.onShow()
    await flush()

    expect(listTrashMock).not.toHaveBeenCalled()
  })
})
