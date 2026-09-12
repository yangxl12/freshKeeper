import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '../../miniprogram/services/settings-service'

const originalWx = globalThis.wx

afterEach(() => {
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

describe('settings service contract', () => {
  it('updates reminder days without submitting a default storage location', async () => {
    let requestedName = ''
    let requestData: Record<string, unknown> | undefined
    globalThis.wx = {
      cloud: {
        callFunction: vi.fn((request) => {
          requestedName = request.name
          requestData = request.data
          request.success({
            result: {
              ok: true,
              data: { defaultReminderLeadDays: 7 },
              requestId: 'req-settings',
            },
          })
        }),
      },
    } as never

    await expect(updateSettings({ defaultReminderLeadDays: 7 })).resolves.toMatchObject({
      defaultReminderLeadDays: 7,
    })
    // 设置已经并进 userApi，不再是独立的 settingsApi 云函数。
    expect(requestedName).toBe('userApi')
    expect(requestData).toEqual({
      action: 'updateSettings',
      data: { defaultReminderLeadDays: 7 },
    })
  })

  it('retries once when an older cloud function still requires the retired field', async () => {
    const requests: Array<Record<string, unknown>> = []
    globalThis.wx = {
      cloud: {
        callFunction: vi.fn((request) => {
          requests.push(request.data)
          if (requests.length === 1) {
            request.success({
              result: {
                ok: false,
                error: { code: 'INVALID_ARGUMENT', message: '默认存放位置不正确' },
                requestId: 'req-legacy',
              },
            })
            return
          }
          request.success({
            result: {
              ok: true,
              data: { defaultReminderLeadDays: 5, defaultStorageLocation: null },
              requestId: 'req-retry',
            },
          })
        }),
      },
    } as never

    await expect(updateSettings({ defaultReminderLeadDays: 5 })).resolves.toMatchObject({
      defaultReminderLeadDays: 5,
    })
    expect(requests).toEqual([
      { action: 'updateSettings', data: { defaultReminderLeadDays: 5 } },
      {
        action: 'updateSettings',
        data: { defaultReminderLeadDays: 5, defaultStorageLocation: null },
      },
    ])
  })
})
