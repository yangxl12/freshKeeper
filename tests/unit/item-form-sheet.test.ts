import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回归测试：item-form-sheet 里「到期日期 ↔ 保质期计算」来回切换不得清空已填数据。
 * 曾经的 bug：handleModeChange 会把对侧字段一起置空，用户在快速录入的草稿编辑弹窗里
 * 切走再切回，原本填好的到期日期就消失了。
 */

vi.mock('../../miniprogram/services/inventory-service', () => ({
  getItem: vi.fn(), saveItem: vi.fn(), restoreItem: vi.fn(), generateItemCover: vi.fn(),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  readReminderAuthorization: vi.fn(async () => ({ authorized: false, summary: '' })),
}))
vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: vi.fn(async () => ({ defaultReminderLeadDays: 1 })),
  updateSettings: vi.fn(),
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
  return instance
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
