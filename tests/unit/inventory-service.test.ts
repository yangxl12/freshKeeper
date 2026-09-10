import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  batchDeleteItems,
  deleteItem,
  generateItemCover,
  listTrash,
  onItemCoverReady,
} from '../../miniprogram/services/inventory-service'

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
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

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
