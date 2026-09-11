import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 回归测试：item-form-sheet 里「到期日期 ↔ 保质期计算」来回切换不得清空已填数据。
 * 曾经的 bug：handleModeChange 会把对侧字段一起置空，用户在快速录入的草稿编辑弹窗里
 * 切走再切回，原本填好的到期日期就消失了。
 */

const saveItemMock = vi.fn(async () => ({ itemId: 'created-1', version: 1, expiryDate: '2026-12-31' }))
const restoreItemMock = vi.fn(async () => undefined)
const armReminderMock = vi.fn(async () => ({ status: 'scheduled', remindDate: '2026-12-30' }))
const requestReminderAuthorizationMock = vi.fn(async () => true)
const updateSettingsMock = vi.fn()

vi.mock('../../miniprogram/services/inventory-service', () => ({
  getItem: vi.fn(),
  saveItem: (...args: unknown[]) => saveItemMock(...(args as [])),
  restoreItem: (...args: unknown[]) => restoreItemMock(...(args as [])),
  generateItemCover: vi.fn(async () => undefined),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  armReminder: (...args: unknown[]) => armReminderMock(...(args as [])),
  requestReminderAuthorization: () => requestReminderAuthorizationMock(),
}))
vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: vi.fn(async () => ({ defaultReminderLeadDays: 1 })),
  updateSettings: updateSettingsMock,
}))
vi.mock('../../miniprogram/utils/analytics', () => ({ track: vi.fn() }))

const originalComponent = globalThis.Component
const originalWx = globalThis.wx
let sheetDefinition: Record<string, any>

beforeAll(async () => {
  globalThis.Component = ((definition: Record<string, unknown>) => {
    sheetDefinition = definition as Record<string, any>
  }) as never
  globalThis.wx = { pageScrollTo: vi.fn(), showToast: vi.fn(), openSetting: vi.fn() } as never
  await import('../../miniprogram/components/item-form-sheet/index')
})

afterAll(() => {
  globalThis.Component = originalComponent
  globalThis.wx = originalWx
})

beforeEach(() => {
  vi.clearAllMocks()
  saveItemMock.mockResolvedValue({ itemId: 'created-1', version: 1, expiryDate: '2026-12-31' })
  requestReminderAuthorizationMock.mockResolvedValue(true)
  armReminderMock.mockResolvedValue({ status: 'scheduled', remindDate: '2026-12-30' })
})

/** 造一个组件实例：properties 初值合并进 data，setData 用顶层键合并。 */
function sheetInstance(mode: 'direct' | 'shelf_life') {
  const data: Record<string, unknown> = { ...structuredClone(sheetDefinition.data) }
  for (const [key, prop] of Object.entries(sheetDefinition.properties ?? {})) {
    data[key] = (prop as { value?: unknown }).value
  }
  data.mode = mode
  const instance: Record<string, any> = { ...sheetDefinition.methods, data }
  instance.setData = (patch: Record<string, unknown>, callback?: () => void) => {
    Object.assign(instance.data, patch)
    callback?.()
  }
  instance.triggerEvent = vi.fn()
  return instance
}

/** 一份能通过校验的新增表单（到期日在未来）。 */
function fillValidNewItem(instance: Record<string, any>) {
  Object.assign(instance.data, {
    name: '牛奶',
    quantity: '2',
    unit: '盒',
    reminderLeadDays: '3',
    expiryDate: '2099-12-31',
    today: '2026-09-11',
  })
}

function switchMode(instance: Record<string, any>, mode: string) {
  instance.handleModeChange({ currentTarget: { dataset: { mode } } })
}

describe('item-form-sheet 到期计算方式切换', () => {
  it('从到期日期切到保质期计算再切回来，到期日期不丢', () => {
    const sheet = sheetInstance('direct')
    sheet.data.expiryDate = '2026-09-20'

    switchMode(sheet, 'shelf_life')
    expect(sheet.data.mode).toBe('shelf_life')
    expect(sheet.data.expiryDate).toBe('2026-09-20')

    switchMode(sheet, 'direct')
    expect(sheet.data.mode).toBe('direct')
    expect(sheet.data.expiryDate).toBe('2026-09-20')
  })

  it('从保质期计算切回再切走，生产日期/保质期不丢且预览自动恢复', () => {
    const sheet = sheetInstance('direct')
    switchMode(sheet, 'shelf_life')
    sheet.data.productionDate = '2026-09-01'
    sheet.data.shelfLifeValue = '7'
    sheet.data.shelfLifeUnitIndex = 0
    sheet.updateExpiryPreview()
    const preview = sheet.data.expiryPreview
    expect(preview).toBe('2026-09-08')

    switchMode(sheet, 'direct')
    expect(sheet.data.productionDate).toBe('2026-09-01')
    expect(sheet.data.shelfLifeValue).toBe('7')

    switchMode(sheet, 'shelf_life')
    expect(sheet.data.productionDate).toBe('2026-09-01')
    expect(sheet.data.shelfLifeValue).toBe('7')
    expect(sheet.data.expiryPreview).toBe(preview)
  })

  it('回传字段仍按当前 mode 取一侧，未选中侧固定为 null（不串味）', () => {
    const sheet = sheetInstance('direct')
    sheet.data.expiryDate = '2026-09-20'
    switchMode(sheet, 'shelf_life')

    // 切到保质期模式但没填生产日期/保质期：回传的到期日为 null，不会把旧的 expiryDate 带出去。
    const fields = sheet.collectDraftFields()
    expect(fields.expiryInputMode).toBe('shelf_life')
    expect(fields.expiryDate).toBeNull()
    expect(fields.productionDate).toBeNull()
  })

  it('重复点击当前模式不产生脏标记', () => {
    const sheet = sheetInstance('direct')
    sheet.data.dirty = false
    switchMode(sheet, 'direct')
    expect(sheet.data.dirty).toBe(false)
  })
})

/**
 * 提醒相关的收口约定（改坏了会退回「四个概念八个入口」的老账）：
 * 表单里只剩「到期前 N 天」+「保存后开启提醒」，既不碰账号默认值，也不碰微信授权状态。
 */
describe('item-form-sheet 到期提醒', () => {
  it('不再提供账号默认天数与授权开关的第二入口', () => {
    expect(sheetDefinition.methods.saveReminderSettings).toBeUndefined()
    expect(sheetDefinition.methods.handleReminderAuthSwitch).toBeUndefined()
    expect(sheetDefinition.methods.readReminderAuthorization).toBeUndefined()
    expect(sheetDefinition.methods.openNotificationSettings).toBeUndefined()
    expect(sheetDefinition.data.reminderSettingsVisible).toBeUndefined()
    expect(sheetDefinition.data.subscriptionAuthorized).toBeUndefined()
  })

  it('「保存后开启提醒」默认开启且可来回切换', () => {
    const sheet = sheetInstance('direct')
    expect(sheet.data.remindAfterSave).toBe(true)
    sheet.toggleRemindAfterSave()
    expect(sheet.data.remindAfterSave).toBe(false)
    sheet.toggleRemindAfterSave()
    expect(sheet.data.remindAfterSave).toBe(true)
  })

  it('新增保存成功后先申请授权再挂提醒，最后才通知宿主', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)

    await sheet.save()

    expect(requestReminderAuthorizationMock).toHaveBeenCalledTimes(1)
    expect(armReminderMock).toHaveBeenCalledWith('created-1')
    expect(sheet.triggerEvent).toHaveBeenCalledWith('saved', expect.anything())
    // 授权弹窗必须发生在宿主跳转之前，否则会被 navigateBack 打断。
    const armOrder = armReminderMock.mock.invocationCallOrder[0]
    const savedOrder = (sheet.triggerEvent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(armOrder).toBeLessThan(savedOrder)
  })

  it('用户取消勾选时不申请授权也不挂提醒', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)
    sheet.toggleRemindAfterSave()

    await sheet.save()

    expect(requestReminderAuthorizationMock).not.toHaveBeenCalled()
    expect(armReminderMock).not.toHaveBeenCalled()
    expect(sheet.triggerEvent).toHaveBeenCalledWith('saved', expect.anything())
  })

  it('编辑已有物品不顺手挂提醒（交给详情页决定）', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)
    sheet.data.itemId = 'existing-1'
    sheet.data.version = 3

    await sheet.save()

    expect(requestReminderAuthorizationMock).not.toHaveBeenCalled()
    expect(armReminderMock).not.toHaveBeenCalled()
  })

  it('到期日已过时直接说明不提醒，不弹授权', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)
    sheet.data.expiryDate = '2020-01-01'

    await sheet.save()

    expect(requestReminderAuthorizationMock).not.toHaveBeenCalled()
    expect(armReminderMock).not.toHaveBeenCalled()
    expect(globalThis.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '已过期，不提醒' }),
    )
  })

  it('挂提醒失败不影响保存成功的结果', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)
    armReminderMock.mockRejectedValueOnce(new Error('REMINDER_NOT_CONFIGURED'))

    await sheet.save()

    expect(sheet.data.errorMessage).toBe('')
    expect(sheet.triggerEvent).toHaveBeenCalledWith('saved', expect.anything())
    expect(globalThis.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '提醒未能开启' }),
    )
  })

  it('用户拒绝授权时不再叠一层提示，保存照常完成', async () => {
    const sheet = sheetInstance('direct')
    fillValidNewItem(sheet)
    requestReminderAuthorizationMock.mockResolvedValueOnce(false)

    await sheet.save()

    expect(armReminderMock).not.toHaveBeenCalled()
    expect(globalThis.wx.showToast).not.toHaveBeenCalled()
    expect(sheet.triggerEvent).toHaveBeenCalledWith('saved', expect.anything())
  })

  /**
   * 快速录入的草稿编辑复用同一张表单，提醒开关必须一路贯通：
   * 弹窗里看得到 → 切换得了 → 点「完成」把意向交回草稿 → 下次打开还能还原。
   */
  describe('草稿编辑模式', () => {
    it('提醒开关不再被 purpose=draft 挡掉', () => {
      const formTemplate = readFileSync(resolve(process.cwd(), 'miniprogram/components/item-form-sheet/index.wxml'), 'utf8')
      expect(formTemplate).toContain('class="remind-option')
      expect(formTemplate).toContain('wx:if="{{!itemId && !restore}}"')
    })

    it('切换开关后随「完成」把意向回传给宿主', () => {
      const sheet = sheetInstance('direct')
      sheet.data.purpose = 'draft'
      expect(sheet.data.remindAfterSave).toBe(true)

      sheet.toggleRemindAfterSave()

      expect(sheet.collectDraftFields().remindAfterSave).toBe(false)
    })

    it('宿主灌入的草稿带回自己保存过的提醒意向', async () => {
      const sheet = sheetInstance('direct')
      sheet.data.purpose = 'draft'

      await sheet.loadDefaults({ name: '牛奶', remindAfterSave: false })

      expect(sheet.data.remindAfterSave).toBe(false)
    })
  })
})
