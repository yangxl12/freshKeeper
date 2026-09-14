import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 锁死物品详情页的「提醒时间」展示。
 *
 * 提醒已经全部改走订阅消息，详情页不再有旧提醒开关或取消按钮：
 * 时间由「到期日期 - 提前天数（当天 09:30）」算出来，正常待发送状态不展示技术任务文案。
 */

const { getItemMock } = vi.hoisted(() => ({ getItemMock: vi.fn() }))

vi.mock('../../miniprogram/services/inventory-service', () => ({
  completeItem: vi.fn(),
  deleteItem: vi.fn(),
  getItem: getItemMock,
  permanentlyDeleteItem: vi.fn(),
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

/** 到期 2099-09-30、提前 3 天 → 提醒时间 2099-09-27 09:30。 */
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
    expiryDate: '2099-09-30',
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

describe('物品详情 · 提醒时间', () => {
  it('默认启用的待发送提醒只展示时间，不暴露内部任务状态', async () => {
    const page = await loadWith({ reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2099年9月27日 09:30')
    expect(page.data.item.reminderAtNote).toBe('')

    const scheduledPage = await loadWith({ reminderStatus: 'scheduled' })
    expect(scheduledPage.data.item.reminderAtNote).toBe('')
  })

  it('提前 0 天时提醒时间就是到期日当天 09:30', async () => {
    const page = await loadWith({ reminderLeadDays: 0, reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2099年9月30日 09:30')
  })

  it('已经推送过的只标注状态，不再给任何操作暗示', async () => {
    const page = await loadWith({ reminderStatus: 'sent' })
    expect(page.data.item.reminderAtText).toBe('2099年9月27日 09:30')
    expect(page.data.item.reminderAtNote).toBe('微信服务通知已发送')
  })

  it.each([
      ['sending', '微信服务通知发送中'],
      ['unknown', '微信通知结果待确认，不会自动重发'],
  ])('推送中/结果未确定（%s）如实标注', async (status, note) => {
    const page = await loadWith({ reminderStatus: status })
    expect(page.data.item.reminderAtNote).toBe(note)
  })

  it('提醒时刻已过的标记为已错过', async () => {
    // 到期 2020-01-01、提前 3 天 → 2019-12-29 09:30，早就过去了。
    const page = await loadWith({ expiryDate: '2020-01-01', reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2019年12月29日 09:30')
    expect(page.data.item.reminderAtNote).toBe('提醒时间已过，不再发送')
  })

  it('非在库物品直接标为已停止推送', async () => {
    const page = await loadWith({ inventoryStatus: 'used_up', reminderStatus: null })
    expect(page.data.item.reminderAtNote).toBe('微信服务通知已停止')
  })

  it('到期日期非法时不编造时间', async () => {
    const page = await loadWith({ expiryDate: 'not-a-date', reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('')
    expect(page.data.item.reminderAtNote).toBe('')
  })

  it('没有旧提醒开关、补开/取消入口或提醒弹窗', () => {
    expect(detailPage.data.reminderSheetVisible).toBeUndefined()
    for (const method of [
      'openReminder', 'closeReminder', 'requestReminder', 'enableReminder', 'cancelReminder',
    ]) {
      expect(detailPage[method]).toBeUndefined()
    }
  })

})
