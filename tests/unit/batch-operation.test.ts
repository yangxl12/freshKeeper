import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryItem } from '../../miniprogram/types/inventory'

const {
  batchCompleteItemsMock,
  batchDeleteItemsMock,
  batchPermanentlyDeleteItemsMock,
  listInventoryMock,
  listTrashMock,
} = vi.hoisted(() => ({
  batchCompleteItemsMock: vi.fn(),
  batchDeleteItemsMock: vi.fn(),
  batchPermanentlyDeleteItemsMock: vi.fn(),
  listInventoryMock: vi.fn(),
  listTrashMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/inventory-service', () => ({
  batchCompleteItems: batchCompleteItemsMock,
  batchDeleteItems: batchDeleteItemsMock,
  batchPermanentlyDeleteItems: batchPermanentlyDeleteItemsMock,
  listInventory: listInventoryMock,
  listTrash: listTrashMock,
}))

const originalPage = globalThis.Page
const originalWx = globalThis.wx
const originalGetApp = (globalThis as { getApp?: unknown }).getApp

let batchPage: Record<string, any>
let app: { globalData: { pendingBatchIntent: unknown } }
let modalCalls: Array<Record<string, any>>
let toastCalls: Array<Record<string, any>>
let modalConfirm: boolean
let navigateBackCount: number

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    batchPage = definition
  }) as never
  await import('../../miniprogram/pages/batch-operation/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
  ;(globalThis as { getApp?: unknown }).getApp = originalGetApp
})

function instance() {
  const page: any = { ...batchPage, data: structuredClone(batchPage.data) }
  page.setData = (patch: object, callback?: () => void) => {
    Object.assign(page.data, patch)
    callback?.()
  }
  return page
}

function stubWx() {
  modalCalls = []
  toastCalls = []
  modalConfirm = true
  navigateBackCount = 0
  globalThis.wx = {
    setNavigationBarTitle: vi.fn(),
    showModal: vi.fn((options: Record<string, unknown>) => {
      modalCalls.push(options)
      return Promise.resolve({ confirm: modalConfirm })
    }),
    showToast: vi.fn((options: Record<string, unknown>) => {
      toastCalls.push(options)
    }),
    navigateBack: vi.fn(() => {
      navigateBackCount += 1
    }),
  } as never
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function item(id: string, version = 1): InventoryItem {
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
    version,
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

function trashPage(items: InventoryItem[], nextCursor: string | null = null) {
  return { items, nextCursor, serverToday: '2026-09-11' }
}

function succeedAll(chunk: Array<{ itemId: string }>) {
  return Promise.resolve({ succeeded: chunk.map((entry) => entry.itemId), failed: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubWx()
  modalConfirm = true
  app = { globalData: { pendingBatchIntent: null } }
  ;(globalThis as { getApp?: unknown }).getApp = () => app
  listTrashMock.mockResolvedValue(trashPage([]))
  listInventoryMock.mockResolvedValue(trashPage([]))
  batchCompleteItemsMock.mockImplementation(succeedAll)
  batchDeleteItemsMock.mockImplementation(succeedAll)
  batchPermanentlyDeleteItemsMock.mockImplementation(succeedAll)
})

describe('批量操作 → 回收站范围', () => {
  it('带搜索词拉取回收站，工具栏显示搜索词与件数', async () => {
    app.globalData.pendingBatchIntent = { source: 'trash', search: '牛奶' }
    listTrashMock.mockResolvedValue(trashPage([item('a'), item('b')]))

    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()

    expect(listTrashMock).toHaveBeenCalledWith({ search: '牛奶', cursor: null })
    expect(page.data.scopeLabel).toBe('搜索：牛奶 · 2 件')
    expect(page.data.items).toHaveLength(2)
    // 回收站不能「标记为已用完」。
    expect(page.data.canComplete).toBe(false)
    expect(page.data.loading).toBe(false)
  })

  it('意图消费后立刻清空，避免返回再进来还带着旧筛选', async () => {
    app.globalData.pendingBatchIntent = { source: 'trash', search: '酸奶' }
    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()

    expect(app.globalData.pendingBatchIntent).toBeNull()
  })

  it('分页拉完再允许全选，全选覆盖所有页', async () => {
    listTrashMock
      .mockResolvedValueOnce(trashPage([item('a')], 'cursor-1'))
      .mockResolvedValueOnce(trashPage([item('b')]))

    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()

    expect(listTrashMock).toHaveBeenCalledTimes(2)
    expect(page.data.items).toHaveLength(2)
    expect(page.data.scopeLabel).toBe('回收站全部 · 2 件')

    page.toggleAll()
    expect(page.data.selectedCount).toBe(2)
    expect(page.data.allSelected).toBe(true)

    page.toggleAll()
    expect(page.data.selectedCount).toBe(0)
    expect(page.data.allSelected).toBe(false)
  })

  it('翻多页时按档位下发，不把已加载数组反复重传', async () => {
    // 250 条 = 9 页（每页 30）：应只在跨过 100 / 200 档位和结束时下发，远少于「每页一次」。
    // 不能用一次性 mockResolvedValue：批量页会一直翻到 nextCursor 为 null。
    const pages = Array.from({ length: 9 }, (_, page) =>
      trashPage(
        Array.from({ length: 30 }, (_, index) => item(`p${page}i${index}`)),
        page < 8 ? `cursor-${page}` : null,
      ),
    )
    listTrashMock.mockImplementation(() => Promise.resolve(pages.shift() ?? trashPage([])))

    const setDataCalls: Array<Record<string, unknown>> = []
    const page = instance()
    const originalSetData = page.setData
    page.setData = (patch: Record<string, unknown>, callback?: () => void) => {
      setDataCalls.push(patch)
      originalSetData(patch, callback)
    }

    page.onLoad({ source: 'trash' })
    await flush()

    expect(listTrashMock).toHaveBeenCalledTimes(9)
    expect(page.data.items).toHaveLength(270)
    const itemEmits = setDataCalls.filter((patch) => 'items' in patch)
    // 9 页只有 4 次下发（onLoad 清空一次 + 100 条档 + 200 条档 + 收尾），而不是 9 次。
    expect(itemEmits.length).toBeLessThanOrEqual(4)
    expect(itemEmits.length).toBeLessThan(9)
    expect(page.data.scopeLabel).toBe('回收站全部 · 270 件')
  })

  it('单项点选与取消', async () => {
    listTrashMock.mockResolvedValue(trashPage([item('a'), item('b')]))
    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()

    page.toggleItem({ currentTarget: { dataset: { id: 'a' } } })
    expect(page.data.selectedCount).toBe(1)
    expect(page.data.items[0].selected).toBe(true)

    page.toggleItem({ currentTarget: { dataset: { id: 'a' } } })
    expect(page.data.selectedCount).toBe(0)
  })

  it('全选后彻底删除：确认一次，按 20 条分批提交，成功项从列表移除', async () => {
    const many = Array.from({ length: 25 }, (_, index) => item(`i${index}`))
    listTrashMock.mockResolvedValue(trashPage(many))

    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()
    page.toggleAll()
    await page.deleteSelected()

    expect(modalCalls[0].title).toBe('彻底删除 25 项？')
    expect(modalCalls[0].content).toBe('彻底删除后无法恢复。')
    expect(batchPermanentlyDeleteItemsMock).toHaveBeenCalledTimes(2)
    expect(batchPermanentlyDeleteItemsMock.mock.calls[0][0]).toHaveLength(20)
    expect(batchPermanentlyDeleteItemsMock.mock.calls[1][0]).toHaveLength(5)
    expect(page.data.items).toHaveLength(0)
    expect(page.data.selectedCount).toBe(0)
    expect(toastCalls[toastCalls.length - 1].title).toBe('已彻底删除')
  })

  it('部分失败：弹窗说明失败原因，只保留失败项并保持选中以便重试', async () => {
    listTrashMock.mockResolvedValue(trashPage([item('a'), item('b'), item('c')]))
    batchPermanentlyDeleteItemsMock.mockResolvedValue({
      succeeded: ['a'],
      failed: [
        { itemId: 'b', code: 'CONFLICT', message: '记录已更新' },
        { itemId: 'c', code: 'CONFLICT', message: '记录已更新' },
      ],
    })

    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()
    page.toggleAll()
    await page.deleteSelected()

    expect(modalCalls).toHaveLength(2)
    expect(modalCalls[1].title).toBe('部分操作未完成')
    expect(page.data.items.map((entry: { _id: string }) => entry._id)).toEqual(['b', 'c'])
    expect(page.data.selectedCount).toBe(2)
  })

  it('取消确认弹窗时不提交任何请求', async () => {
    listTrashMock.mockResolvedValue(trashPage([item('a')]))
    modalConfirm = false

    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()
    page.toggleAll()
    await page.deleteSelected()

    expect(batchPermanentlyDeleteItemsMock).not.toHaveBeenCalled()
  })

  it('拉取失败进错误态，不留半截数据', async () => {
    listTrashMock.mockRejectedValue(new Error('网络连接失败'))
    const page = instance()
    page.onLoad({ source: 'trash' })
    await flush()

    expect(page.data.errorMessage).toBe('网络连接失败')
    expect(page.data.loading).toBe(false)
    expect(page.data.items).toHaveLength(0)
  })
})

describe('批量操作 → 库存范围回归', () => {
  it('首页进来的默认按临期筛选，仍可标记为已用完', async () => {
    app.globalData.pendingBatchIntent = { source: 'home', viewStatus: 'expiring' }
    listInventoryMock.mockResolvedValue(trashPage([item('a')]))

    const page = instance()
    page.onLoad({ source: 'home' })
    await flush()

    expect(listInventoryMock).toHaveBeenCalledWith({
      search: '',
      category: '',
      viewStatus: 'expiring',
      cursor: null,
    })
    expect(page.data.canComplete).toBe(true)
    // 非回收站范围不显示回收站文案。
    expect(page.data.scopeLabel).toBe('')
  })

  it('库存范围删除走「移入回收站」，提示文案不同', async () => {
    listInventoryMock.mockResolvedValue(trashPage([item('a')]))
    const page = instance()
    page.onLoad({ source: 'inventory' })
    await flush()
    page.toggleAll()
    await page.deleteSelected()

    expect(modalCalls[0].title).toBe('删除 1 项？')
    expect(batchDeleteItemsMock).toHaveBeenCalledTimes(1)
    expect(batchPermanentlyDeleteItemsMock).not.toHaveBeenCalled()
    expect(toastCalls[toastCalls.length - 1].title).toBe('已移入回收站')
  })
})
