import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  batchCompleteItems,
  batchDeleteItems,
  batchPermanentlyDeleteItems,
  completeItem,
  deleteItem,
  generateItemCover,
  listTrash,
  onItemCoverReady,
  permanentlyDeleteItem,
  restoreItem,
  saveItem,
  updateQuantity,
} from '../../miniprogram/services/inventory-service'
import { cachedOverviewUsable, clearOverviewCache, writeOverviewCache } from '../../miniprogram/services/overview-cache'
import { shanghaiTodayKey } from '../../miniprogram/utils/shanghai-time'
import type { InventoryItem, InventorySaveInput } from '../../miniprogram/types/inventory'

const originalWx = globalThis.wx

function installCloudCall(
  implementation: (request: { name: string; data: Record<string, unknown>; success: (response: unknown) => void; fail: (error: unknown) => void }) => void,
) {
  globalThis.wx = {
    cloud: {
      callFunction: vi.fn(implementation),
    },
  } as never
}

afterEach(() => {
  clearOverviewCache()
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

const saveInput: InventorySaveInput = {
  name: '牛奶',
  quantity: 2,
  unit: '盒',
  category: 'food',
  storageLocation: 'refrigerated',
  expiryInputMode: 'direct',
  productionDate: null,
  shelfLifeValue: null,
  shelfLifeUnit: null,
  expiryDate: '2026-10-01',
  reminderLeadDays: 1,
}

function primeOverview() {
  writeOverviewCache({
    activeTotal: 1,
    expired: 0,
    expiringWithin7Days: 0,
    usedUpTotal: 0,
    safe: 1,
    serverToday: shanghaiTodayKey(),
  })
  expect(cachedOverviewUsable(shanghaiTodayKey())).toBe(true)
}

describe('inventory service compatibility', () => {
  it('uses the explicit move-to-trash contract instead of a legacy status transition', async () => {
    let requestData: Record<string, unknown> | undefined
    installCloudCall((request) => {
      requestData = request.data
      request.success({ result: { ok: true, data: { version: 2 }, requestId: 'req-1' } })
    })

    await expect(deleteItem('item-1', 1)).resolves.toEqual({ version: 2 })
    expect(requestData).toMatchObject({ action: 'moveToTrash', itemId: 'item-1', version: 1 })
  })

  it('falls back to individual delete actions when batch delete is unavailable', async () => {
    const requests: Array<Record<string, unknown>> = []
    installCloudCall((request) => {
      requests.push(request.data)
      if (requests.length === 1) {
        request.success({
          result: {
            ok: false,
            error: { code: 'INVALID_ACTION', message: '不支持的库存操作' },
            requestId: 'req-batch',
          },
        })
        return
      }
      request.success({ result: { ok: true, data: { version: 3 }, requestId: 'req-delete' } })
    })

    await expect(batchDeleteItems([{ itemId: 'used-up-1', version: 2 }])).resolves.toEqual({
      succeeded: ['used-up-1'],
      failed: [],
    })
    expect(requests).toEqual([
      { action: 'batchDelete', items: [{ itemId: 'used-up-1', version: 2 }] },
      { action: 'moveToTrash', itemId: 'used-up-1', version: 2 },
    ])
  })

  it('falls back to the legacy history action when listTrash is unavailable', async () => {
    const requests: Array<Record<string, unknown>> = []
    installCloudCall((request) => {
      requests.push(request.data)
      if (requests.length === 1) {
        request.success({
          result: {
            ok: false,
            error: { code: 'INVALID_ACTION', message: '不支持的库存操作' },
            requestId: 'req-2',
          },
        })
        return
      }
      request.success({
        result: {
          ok: true,
          data: { items: [], nextCursor: null, serverToday: '2026-09-07' },
          requestId: 'req-3',
        },
      })
    })

    await expect(listTrash()).resolves.toMatchObject({ items: [] })
    expect(requests).toEqual([
      { action: 'listTrash', search: '', cursor: null, pageSize: 30 },
      { action: 'listHistory', search: '', status: 'discarded', cursor: null, pageSize: 30 },
    ])
  })
})

describe('overview cache invalidation', () => {
  it('invalidates every mutation that changes overview counts or membership', async () => {
    installCloudCall((request) => {
      const action = String(request.data.action)
      const data = action.startsWith('batch')
        ? { succeeded: ['item-1'], failed: [] }
        : action === 'permanentDelete'
          ? { deleted: true }
          : { itemId: 'item-1', version: 2, expiryDate: '2026-10-01' }
      request.success({ result: { ok: true, data, requestId: `req-${action}` } })
    })

    const calls = [
      () => saveItem(saveInput),
      () => completeItem('item-1', 1),
      () => deleteItem('item-1', 1),
      () => permanentlyDeleteItem('item-1', 1),
      () => restoreItem({ ...saveInput, itemId: 'item-1', version: 1 }),
      () => batchCompleteItems([{ itemId: 'item-1', version: 1 }]),
      () => batchDeleteItems([{ itemId: 'item-1', version: 1 }]),
      () => batchPermanentlyDeleteItems([{ itemId: 'item-1', version: 1 }]),
    ]

    for (const mutate of calls) {
      primeOverview()
      await mutate()
      expect(cachedOverviewUsable(shanghaiTodayKey())).toBe(false)
    }
  })

  it('keeps overview cache valid for quantity-only updates', async () => {
    let requestData: Record<string, unknown> | undefined
    installCloudCall((request) => {
      requestData = request.data
      request.success({ result: { ok: true, data: { quantity: 3, version: 2 }, requestId: 'req-quantity' } })
    })
    primeOverview()

    await updateQuantity({ _id: 'item-1', version: 1 } as InventoryItem, 3)

    expect(cachedOverviewUsable(shanghaiTodayKey())).toBe(true)
    expect(requestData).toEqual({ action: 'setQuantity', itemId: 'item-1', version: 1, quantity: 3 })
  })
})

describe('cover ready notification', () => {
  it('broadcasts the generated cover so the home list can fill it in without a refetch', async () => {
    installCloudCall((request) => {
      request.success({
        result: { ok: true, data: { coverFileId: 'cloud://env.covers/x.png', reused: false }, requestId: 'req-cover' },
      })
    })

    const received: Array<{ itemId: string; coverFileId: string }> = []
    const unsubscribe = onItemCoverReady((cover) => received.push(cover))

    await generateItemCover('item-1')
    expect(received).toEqual([{ itemId: 'item-1', coverFileId: 'cloud://env.covers/x.png' }])

    // 退订后不再收到，避免页面 onHide 之后还往已销毁的实例上 setData。
    unsubscribe()
    await generateItemCover('item-2')
    expect(received).toHaveLength(1)
  })

  it('stays silent when the cloud returns no cover so callers keep the placeholder', async () => {
    installCloudCall((request) => {
      request.success({ result: { ok: true, data: { coverFileId: '' }, requestId: 'req-cover' } })
    })

    const received: unknown[] = []
    const unsubscribe = onItemCoverReady((cover) => received.push(cover))
    await generateItemCover('item-3')
    unsubscribe()

    expect(received).toEqual([])
  })
})
