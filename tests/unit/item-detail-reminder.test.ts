import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 锁死物品详情页的「提醒时间」展示。
 *
 * 提醒已经全部改走订阅消息，详情页不再有旧提醒开关或取消按钮：
 * 时间由「到期日期 - 提前天数（当天 16:00）」算出来，正常待发送状态不展示技术任务文案。
 */

const {
  getItemMock,
  coverReadyMock,
  requestReminderAuthorizationMock,
  armReminderMock,
} = vi.hoisted(() => ({
  getItemMock: vi.fn(),
  // 返回退订函数，和真实实现一致。
  coverReadyMock: vi.fn((): (() => void) => () => {}),
  requestReminderAuthorizationMock: vi.fn(),
  armReminderMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/inventory-service', () => ({
  completeItem: vi.fn(),
  deleteItem: vi.fn(),
  getItem: getItemMock,
  onItemCoverReady: coverReadyMock,
  permanentlyDeleteItem: vi.fn(),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  requestReminderAuthorization: requestReminderAuthorizationMock,
  armReminder: armReminderMock,
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
  requestReminderAuthorizationMock.mockResolvedValue(true)
  armReminderMock.mockResolvedValue({ status: 'scheduled', remindDate: '2099-09-27' })
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

/** 到期 2099-09-30、提前 3 天 → 提醒时间 2099-09-27 16:00。 */
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
  it('没有提醒任务时明确提示并给出补开入口', async () => {
    const page = await loadWith({ reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2099年9月27日 16:00')
    expect(page.data.item.reminderAtNote).toBe('微信提醒未开启')
    expect(page.data.item.canEnableReminder).toBe(true)

    const scheduledPage = await loadWith({ reminderStatus: 'scheduled' })
    expect(scheduledPage.data.item.reminderAtNote).toBe('')
    expect(scheduledPage.data.item.canEnableReminder).toBe(false)
  })

  it('提前 0 天时提醒时间就是到期日当天 16:00', async () => {
    const page = await loadWith({ reminderLeadDays: 0, reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2099年9月30日 16:00')
  })

  it('已经推送过的只标注状态，不再给任何操作暗示', async () => {
    const page = await loadWith({ reminderStatus: 'sent' })
    expect(page.data.item.reminderAtText).toBe('2099年9月27日 16:00')
    expect(page.data.item.reminderAtNote).toBe('微信服务通知已发送')
    expect(page.data.item.canEnableReminder).toBe(false)
  })

  it.each([
      ['sending', '微信服务通知发送中'],
      ['unknown', '微信通知结果待确认，不会自动重发'],
  ])('推送中/结果未确定（%s）如实标注', async (status, note) => {
    const page = await loadWith({ reminderStatus: status })
    expect(page.data.item.reminderAtNote).toBe(note)
  })

  it('提醒时刻已过的标记为已错过', async () => {
    // 到期 2020-01-01、提前 3 天 → 2019-12-29 16:00，早就过去了。
    const page = await loadWith({ expiryDate: '2020-01-01', reminderStatus: null })
    expect(page.data.item.reminderAtText).toBe('2019年12月29日 16:00')
    expect(page.data.item.reminderAtNote).toBe('提醒时间已过，不再发送')
    expect(page.data.item.canEnableReminder).toBe(false)
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

  it('补开提醒从 tap 同步栈申请授权，再创建任务', async () => {
    let resolveAuthorization: ((value: boolean) => void) | undefined
    requestReminderAuthorizationMock.mockReturnValueOnce(new Promise<boolean>((resolve) => {
      resolveAuthorization = resolve
    }))
    const page = await loadWith({ reminderStatus: null })

    const enabling = page.handleEnableReminder()
    expect(requestReminderAuthorizationMock).toHaveBeenCalledTimes(1)
    expect(armReminderMock).not.toHaveBeenCalled()

    resolveAuthorization?.(true)
    await enabling
    expect(armReminderMock).toHaveBeenCalledWith('item-1')
    expect(globalThis.wx.showToast).toHaveBeenCalledWith({ title: '提醒已开启', icon: 'success' })
  })

  it('用户拒绝授权时不创建任务', async () => {
    requestReminderAuthorizationMock.mockResolvedValueOnce(false)
    const page = await loadWith({ reminderStatus: null })

    await page.handleEnableReminder()

    expect(armReminderMock).not.toHaveBeenCalled()
    expect(page.data.actionLoading).toBe(false)
  })

  it('保留旧提醒弹窗和取消入口的清理结果', () => {
    expect(detailPage.data.reminderSheetVisible).toBeUndefined()
    for (const method of [
      'openReminder', 'closeReminder', 'requestReminder', 'enableReminder', 'cancelReminder',
    ]) {
      expect(detailPage[method]).toBeUndefined()
    }
  })

})

describe('物品详情 · 封面', () => {
  it('直接复用列表那张封面（原图 fileID，不加展示层参数）', async () => {
    const cover = 'cloud://env.bucket/covers/item-1.png'
    const page = await loadWith({ coverFileId: cover })
    expect(page.data.item.coverUrl).toBe(cover)
  })

  it('有封面时先进加载态，解码完成才淡入', async () => {
    const page = await loadWith({ coverFileId: 'cloud://env.bucket/covers/item-1.png' })
    // 进页面就是 loading：占位图垫底 + 转圈，真图要等 bindload 之后才被淡入，
    // 不再出现"先显示再被动画拉回透明"的闪动。
    expect(page.data.coverStatus).toBe('loading')

    page.handleCoverLoad()
    expect(page.data.coverStatus).toBe('ready')
  })

  it('没有封面时只显示占位图，不空转圈', async () => {
    const page = await loadWith({})
    expect(page.data.item.coverUrl).toBe('')
    expect(page.data.coverPlaceholder).toBe('/assets/inventory-placeholder.svg')
    expect(page.data.coverStatus).toBe('idle')
  })

  it('生图完成时把封面补到已经打开的详情页，不必退出重进', async () => {
    const cover = 'cloud://env.bucket/covers/item-1.png'
    const page = await loadWith({})
    page.subscribeCoverUpdates()

    const listener = coverReadyMock.mock.calls[0][0]
    listener({ itemId: 'item-1', coverFileId: cover })

    expect(page.data.item.coverUrl).toBe(cover)
    // 走一遍加载态（占位图 + 转圈 → 淡入），而不是把占位图直接切成真图。
    expect(page.data.coverStatus).toBe('loading')
  })

  it('封面广播重复到达且是同一张图时不动状态', async () => {
    const cover = 'cloud://env.bucket/covers/item-1.png'
    const page = await loadWith({ coverFileId: cover })
    page.handleCoverLoad()
    page.subscribeCoverUpdates()

    const listener = coverReadyMock.mock.calls[0][0]
    listener({ itemId: 'item-1', coverFileId: cover })

    expect(page.data.coverStatus).toBe('ready')
  })

  it('只认自己这一件物品的封面广播', async () => {
    const page = await loadWith({})
    page.subscribeCoverUpdates()

    const listener = coverReadyMock.mock.calls[0][0]
    listener({ itemId: 'item-other', coverFileId: 'cloud://env.bucket/covers/other.png' })

    expect(page.data.item.coverUrl).toBe('')
  })

  it('加载失败回退占位图且不反复重试', async () => {
    const page = await loadWith({ coverFileId: 'cloud://env.bucket/covers/gone.png' })

    page.handleCoverError()
    expect(page.data.coverStatus).toBe('failed')
    page.handleCoverError()
    expect(page.data.coverStatus).toBe('failed')
  })

  it('封面没变时重新加载不改状态，避免每次 onShow 都闪一次', async () => {
    const cover = 'cloud://env.bucket/covers/item-1.png'
    const page = await loadWith({ coverFileId: cover })
    page.handleCoverLoad()
    await page.loadItem()

    // onShow 会重跑 loadItem：状态必须停在 ready，不能被打回 loading 重播淡入。
    expect(page.data.coverStatus).toBe('ready')
  })

  it('换成另一张封面才回到加载态', async () => {
    const page = await loadWith({ coverFileId: 'cloud://env.bucket/covers/old.png' })
    page.handleCoverLoad()
    getItemMock.mockResolvedValue(itemWith({ coverFileId: 'cloud://env.bucket/covers/new.png' }))
    await page.loadItem()

    expect(page.data.item.coverUrl).toBe('cloud://env.bucket/covers/new.png')
    expect(page.data.coverStatus).toBe('loading')
  })
})
