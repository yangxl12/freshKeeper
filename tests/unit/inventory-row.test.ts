import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * inventory-row 的数量反馈与输入框宽度。
 *
 * 三条容易回归的约束：
 * 1. 只有数量**真的变化**才播动效 —— 首次渲染、同值、非法值都不该播，否则进页面就闪一下；
 * 2. `flashQuantity` 必须「先摘 class 再下一帧挂回」，否则连续增减只会播第一次；
 * 3. 编辑态输入框宽度跟着字数走 —— 固定 flex 宽度在 4 位数下只剩一条缝，没法看。
 */

const nextTickQueue: Array<() => void> = []
const vibrateShort = vi.fn()

const originalComponent = globalThis.Component
const originalWx = globalThis.wx
let rowDefinition: Record<string, any>

beforeAll(async () => {
  globalThis.Component = ((definition: Record<string, unknown>) => {
    rowDefinition = definition as Record<string, any>
  }) as never
  globalThis.wx = {
    nextTick: (callback: () => void) => nextTickQueue.push(callback),
    vibrateShort,
  } as never
  await import('../../miniprogram/components/inventory-row/index')
})

afterAll(() => {
  globalThis.Component = originalComponent
  globalThis.wx = originalWx
})

beforeEach(() => {
  vi.clearAllMocks()
  nextTickQueue.length = 0
})

function flushNextTick() {
  while (nextTickQueue.length) nextTickQueue.shift()!()
}

/** 造一个组件实例：properties 初值合并进 data，setData 用顶层键合并。 */
function rowInstance(quantity = 1) {
  const data: Record<string, unknown> = { ...structuredClone(rowDefinition.data) }
  for (const [key, prop] of Object.entries(rowDefinition.properties ?? {})) {
    data[key] = (prop as { value?: unknown }).value
  }
  const item = { _id: 'item-1', quantity, unit: '个' }
  data.item = item
  const instance: Record<string, any> = { ...rowDefinition.methods, data }
  instance.properties = { item }
  instance.setData = (patch: Record<string, unknown>, callback?: () => void) => {
    Object.assign(instance.data, patch)
    callback?.()
  }
  instance.triggerEvent = vi.fn()
  return instance
}

/** 模拟 item 属性变化触发数量 observer。 */
function changeQuantity(instance: Record<string, any>, next: unknown) {
  rowDefinition.observers['item.quantity'].call(instance, next)
}

describe('数量变化反馈', () => {
  it('首次拿到真实数量只记基准，不播动效也不震动', () => {
    const row = rowInstance(3)
    changeQuantity(row, 3)

    expect(row.data.lastQuantity).toBe(3)
    expect(row.data.quantityFlash).toBe('')
    expect(vibrateShort).not.toHaveBeenCalled()
  })

  it('数量增加播 up 动效，并补一次轻震动 + 播报文本', () => {
    const row = rowInstance(2)
    changeQuantity(row, 2)
    changeQuantity(row, 3)
    flushNextTick()

    expect(row.data.quantityFlash).toBe('item-card__quantity-value--up')
    expect(row.data.quantityA11yText).toBe('数量已改为 3')
    expect(vibrateShort).toHaveBeenCalledTimes(1)
    expect(vibrateShort).toHaveBeenCalledWith(expect.objectContaining({ type: 'light' }))
  })

  it('数量减少播 down 动效', () => {
    const row = rowInstance(5)
    changeQuantity(row, 5)
    changeQuantity(row, 4)
    flushNextTick()

    expect(row.data.quantityFlash).toBe('item-card__quantity-value--down')
    expect(vibrateShort).toHaveBeenCalledTimes(1)
  })

  it('数量没变化不播动效', () => {
    const row = rowInstance(2)
    changeQuantity(row, 2)
    changeQuantity(row, 2)
    flushNextTick()

    expect(row.data.quantityFlash).toBe('')
    expect(vibrateShort).not.toHaveBeenCalled()
  })

  it('非法数量直接忽略，既不播也不污染基准', () => {
    const row = rowInstance(2)
    changeQuantity(row, 2)

    changeQuantity(row, undefined)
    changeQuantity(row, 1.5)

    expect(row.data.lastQuantity).toBe(2)
    expect(row.data.quantityFlash).toBe('')
    expect(vibrateShort).not.toHaveBeenCalled()
  })

  it('连续同向变化每次都重放：同一种 tone 也要先摘掉 class', () => {
    const row = rowInstance(1)
    changeQuantity(row, 1)

    changeQuantity(row, 2)
    // 摘 class 与挂 class 分属两帧，动画才能重启。
    expect(row.data.quantityFlash).toBe('')
    flushNextTick()
    expect(row.data.quantityFlash).toBe('item-card__quantity-value--up')

    changeQuantity(row, 3)
    expect(row.data.quantityFlash).toBe('')
    flushNextTick()
    expect(row.data.quantityFlash).toBe('item-card__quantity-value--up')
    expect(vibrateShort).toHaveBeenCalledTimes(2)
  })
})

describe('数量输入框宽度', () => {
  it('进入编辑态按当前数量给宽度', () => {
    const row = rowInstance(12)
    row.handleQuantityTap()

    expect(row.data.editing).toBe(true)
    expect(row.data.editValue).toBe('12')
    expect(row.data.editInputWidth).toBe(76)
  })

  it('宽度随字数逐档变宽，4 位数最宽', () => {
    const row = rowInstance(1)
    row.handleQuantityTap()

    const widths = ['9', '99', '999', '9999'].map((value) => {
      row.handleEditInput({ detail: { value } })
      return row.data.editInputWidth
    })

    expect(widths).toEqual([56, 76, 96, 116])
  })

  it('删空输入回落到最窄一档', () => {
    const row = rowInstance(999)
    row.handleQuantityTap()
    row.handleEditInput({ detail: { value: '' } })

    expect(row.data.editInputWidth).toBe(56)
  })

  it('提交后退出编辑态并复位宽度', () => {
    const row = rowInstance(12)
    row.handleQuantityTap()
    row.handleEditInput({ detail: { value: '1234' } })
    row.commitEdit()

    expect(row.data.editing).toBe(false)
    expect(row.data.editInputWidth).toBe(56)
  })

  it('提交有效新值才派发 quantityset，没变化就静默还原', () => {
    const changed = rowInstance(2)
    changed.handleQuantityTap()
    changed.handleEditInput({ detail: { value: '5' } })
    changed.commitEdit()
    expect(changed.triggerEvent).toHaveBeenCalledWith('quantityset', { itemId: 'item-1', quantity: 5 })

    const unchanged = rowInstance(2)
    unchanged.handleQuantityTap()
    unchanged.handleEditInput({ detail: { value: '2' } })
    unchanged.commitEdit()
    expect(unchanged.triggerEvent).not.toHaveBeenCalled()
  })
})
