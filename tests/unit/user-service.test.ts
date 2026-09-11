import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteAccount, getUserProfile, touchUser, touchUserOnceToday } from '../../miniprogram/services/user-service'
import { shanghaiTodayKey } from '../../miniprogram/utils/shanghai-time'

const originalWx = globalThis.wx
const TOUCH_STORAGE_KEY = 'user_touch_date'

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function stubWx(respond: (request: { data: Record<string, unknown> }) => void) {
  const storage: Record<string, unknown> = {}
  globalThis.wx = {
    cloud: {
      callFunction: vi.fn((request: { data: Record<string, unknown> }) => respond(request)),
    },
    getStorageSync: (key: string) => (key in storage ? storage[key] : ''),
    setStorageSync: (key: string, value: unknown) => {
      storage[key] = value
    },
  } as never
  return storage
}

afterEach(() => {
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

describe('user service contract', () => {
  it('touch 只上报一次活跃度，不携带任何身份字段', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({ result: { ok: true, data: { created: true, lastSeenAt: '2026-09-11' }, requestId: 'r1' } })
    })

    await expect(touchUser()).resolves.toEqual({ created: true, lastSeenAt: '2026-09-11' })
    expect(requestData).toEqual({ action: 'touch' })
    expect(Object.keys(requestData as Record<string, unknown>)).not.toContain('ownerId')
  })

  it('get 读取档案', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: {
          ok: true,
          data: { nickname: null, avatarFileId: null, createdAt: null, lastSeenAt: null },
          requestId: 'r2',
        },
      })
    })

    await expect(getUserProfile()).resolves.toMatchObject({ nickname: null })
    expect(requestData).toEqual({ action: 'get' })
  })

  it('deleteAccount 必须带确认词 DELETE', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: {
          ok: true,
          data: { deleted: { items: 3, reminders: 1, settings: 1, files: 2 } },
          requestId: 'r3',
        },
      })
    })

    await expect(deleteAccount()).resolves.toMatchObject({ deleted: { items: 3 } })
    expect(requestData).toEqual({ action: 'deleteAccount', data: { confirm: 'DELETE' } })
  })
})

describe('客户端同日节流', () => {
  it('同一天只调一次，成功后写入本地标记', async () => {
    const requests: Array<Record<string, unknown>> = []
    const storage = stubWx((request) => {
      requests.push(request.data)
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: { ok: true, data: { created: true, lastSeenAt: shanghaiTodayKey() }, requestId: 'r' },
      })
    })

    touchUserOnceToday()
    await flush()
    touchUserOnceToday()
    await flush()

    expect(requests).toEqual([{ action: 'touch' }])
    expect(storage[TOUCH_STORAGE_KEY]).toBe(shanghaiTodayKey())
  })

  it('调用失败不写本地标记，下次启动会重试', async () => {
    const requests: Array<Record<string, unknown>> = []
    const storage = stubWx((request) => {
      requests.push(request.data)
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' }, requestId: 'r' },
      })
    })

    touchUserOnceToday()
    await flush()
    touchUserOnceToday()
    await flush()

    expect(requests).toHaveLength(2)
    expect(storage[TOUCH_STORAGE_KEY]).toBeUndefined()
  })

  it('存储读写抛异常也不能冒泡到启动流程', () => {
    globalThis.wx = {
      cloud: { callFunction: vi.fn() },
      getStorageSync: () => {
        throw new Error('storage broken')
      },
      setStorageSync: vi.fn(),
    } as never
    expect(() => touchUserOnceToday()).not.toThrow()
  })
})

describe('shanghaiTodayKey', () => {
  it('按上海时区跨日，而不是本地时区', () => {
    expect(shanghaiTodayKey(new Date('2026-09-10T15:59:00Z'))).toBe('2026-09-10')
    expect(shanghaiTodayKey(new Date('2026-09-10T16:00:00Z'))).toBe('2026-09-11')
  })
})
