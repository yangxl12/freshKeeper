import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 锁死物品详情页的「到期提醒」状态机。
 *
 * 微信一次性订阅的事实：一次授权换一条额度，发出去就结束。所以终态
 * （sending / sent / unknown）必须没有任何可点按钮，也不能出现「还能再开一次」的暗示；
 * 能重新开启的只有 failed / cancelled / 没有任务，与云端 reminderApi/rules.js 一致。
 */

const { getItemMock, armReminderMock, cancelReminderMock, requestAuthorizationMock } = vi.hoisted(() => ({
  getItemMock: vi.fn(),
  armReminderMock: vi.fn(),
  cancelReminderMock: vi.fn(),
  requestAuthorizationMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/inventory-service', () => ({
  completeItem: vi.fn(),
  deleteItem: vi.fn(),
  getItem: getItemMock,
  permanentlyDeleteItem: vi.fn(),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  armReminder: armReminderMock,
  cancelReminder: cancelReminderMock,
  requestReminderAuthorization: requestAuthorizationMock,
}))
vi.mock('../../miniprogram/utils/analytics', () => ({ track: vi.fn() }))

const originalPage = globalThis.Page
const originalWx = globalThis.wx
let detailPage: Record<string, any>

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    detailPage = definition as Record<string, any>
  }) as never
  await import('../../miniprogram/pages/item-detail/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
})

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.wx = {
    showToast: vi.fn(),
    setNavigationBarTitle: vi.fn(),
    navigateBack: vi.fn(),
  } as never
  requestAuthorizationMock.mockResolvedValue(true)
  armReminderMock.mockResolvedValue({ status: 'scheduled', remindDate: '2026-09-27' })
  cancelReminderMock.mockResolvedValue({ status: 'cancelled' })
})

function instance() {
  const page: any = { ...detailPage, data: structuredClone(detailPage.data) }
  page.setData = (patch: object, callback?: () => void) => {
    Object.assign(page.data, patch)
    callback?.()
  }
  page.data.itemId = 'item-1'
  return page
}

/** 到期 2026-09-30、提前 3 天 → 提醒日 2026-09-27。 */
function itemWith(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'item-1',
    name: '牛奶',
    quantity: 1,
    unit: '盒',
    category: 'food',
    storageLocation: '冰箱',
    expiryInputMode: 'direct',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: '2026-09-30',
    reminderLeadDays: 3,
    inventoryStatus: 'active',
    version: 1,
    expiryStatus: 'safe',
    daysLeft: 19,
    expiryStatusText: '还有 19 天',
    expiryTone: 'safe',
    categoryLabel: '食品',
    storageLabel: '冰箱',
    inventoryStatusLabel: '在库',
    ...overrides,
  }
}

async function loadWith(overrides: Record<string, unknown> = {}) {
  const page = instance()
  getItemMock.mockResolvedValue(itemWith(overrides))
  await page.loadItem()
  return page
}

describe('物品详情 · 到期提醒状态机', () => {
  it('没有提醒任务时可以开启，说明里带上真实推送日期', async () => {
    const page = await loadWith({ reminderStatus: null })
    expect(page.data.item.reminderStateText).toBe('未开启')
    expect(page.data.item.reminderSendDateText).toBe('9 月 27 日')
    expect(page.data.item.reminderCopy).toContain('9 月 27 日')
    expect(page.data.item.reminderArmText).toBe('开启到期提醒')
    expect(page.data.item.canArmReminder).toBe(true)
    expect(page.data.item.canCancelReminder).toBe(false)
  })

  it('已预约时只能取消，状态位直接显示发送日期', async () => {
    const page = await loadWith({ reminderStatus: 'scheduled' })
    expect(page.data.item.reminderStateText).toBe('已预约 · 9 月 27 日')
    expect(page.data.item.canCancelReminder).toBe(true)
    expect(page.data.item.canArmReminder).toBe(false)
  })

  it.each([
    ['sending', '正在发送'],
    ['sent', '已发送'],
    ['unknown', '结果未确定'],
  ])('终态 %s 不给任何按钮，也不承诺还能再开', async (status, stateText) => {
    const page = await loadWith({ reminderStatus: status })
    expect(page.data.item.reminderStateText).toBe(stateText)
    expect(page.data.item.canArmReminder).toBe(false)
    expect(page.data.item.canCancelReminder).toBe(false)
    expect(page.data.item.reminderCopy).not.toContain('可以重新开启')
  })

  it.each([
    ['failed', '发送失败'],
    ['cancelled', '已取消'],
  ])('可恢复状态 %s 允许重新开启', async (status, stateText) => {
    const page = await loadWith({ reminderStatus: status })
    expect(page.data.item.reminderStateText).toBe(stateText)
    expect(page.data.item.canArmReminder).toBe(true)
    expect(page.data.item.reminderArmText).toBe('重新开启提醒')
  })

  it('已过期的物品不给开启入口，且明说不再提醒', async () => {
    const page = await loadWith({ expiryStatus: 'expired', reminderStatus: null })
    expect(page.data.item.reminderStateText).toBe('已过期')
    expect(page.data.item.reminderCopy).toContain('不再发送提醒')
    expect(page.data.item.canArmReminder).toBe(false)
  })

  it('已用完 / 回收站里的物品不能开启提醒', async () => {
    const page = await loadWith({ inventoryStatus: 'used_up', reminderStatus: null })
    expect(page.data.item.canArmReminder).toBe(false)
  })

  it('提前 0 天时提醒日就是到期日', async () => {
    const page = await loadWith({ reminderLeadDays: 0, reminderStatus: null })
    expect(page.data.item.reminderSendDateText).toBe('9 月 30 日')
  })

  it('开启提醒会先申请授权再挂任务，并刷新详情', async () => {
    const page = await loadWith({ reminderStatus: null })
    getItemMock.mockResolvedValue(itemWith({ reminderStatus: 'scheduled' }))

    await page.requestReminder()

    expect(requestAuthorizationMock).toHaveBeenCalledTimes(1)
    expect(armReminderMock).toHaveBeenCalledWith('item-1')
    expect(page.data.item.reminderStateText).toBe('已预约 · 9 月 27 日')
  })

  it('用户拒绝授权就不挂任务', async () => {
    const page = await loadWith({ reminderStatus: null })
    requestAuthorizationMock.mockResolvedValueOnce(false)

    await page.requestReminder()

    expect(armReminderMock).not.toHaveBeenCalled()
  })

  it('终态下即便被误触也不会发出请求', async () => {
    const page = await loadWith({ reminderStatus: 'sent' })

    await page.requestReminder()
    await page.cancelReminder()

    expect(requestAuthorizationMock).not.toHaveBeenCalled()
    expect(armReminderMock).not.toHaveBeenCalled()
    expect(cancelReminderMock).not.toHaveBeenCalled()
  })

  it('取消提醒只在已预约时可用', async () => {
    const page = await loadWith({ reminderStatus: 'scheduled' })
    getItemMock.mockResolvedValue(itemWith({ reminderStatus: 'cancelled' }))

    await page.cancelReminder()

    expect(cancelReminderMock).toHaveBeenCalledWith('item-1')
    expect(page.data.item.reminderStateText).toBe('已取消')
    expect(page.data.item.canArmReminder).toBe(true)
  })
})
