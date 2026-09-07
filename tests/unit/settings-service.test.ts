import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '../../miniprogram/services/settings-service'

const originalWx = globalThis.wx

afterEach(() => {
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

describe('settings service contract', () => {
  it('updates reminder days without submitting a default storage location', async () => {
    let requestData: Record<string, unknown> | undefined
    globalThis.wx = {
      cloud: {
        callFunction: vi.fn((request) => {
          requestData = request.data
          request.success({
            result: {
              ok: true,
              data: { defaultReminderLeadDays: 7, hasReminderJobs: false },
              requestId: 'req-settings',
            },
          })
        }),
      },
    } as never

    await expect(updateSettings({ defaultReminderLeadDays: 7 })).resolves.toMatchObject({
      defaultReminderLeadDays: 7,
    })
    expect(requestData).toEqual({
      action: 'update',
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
      { action: 'update', data: { defaultReminderLeadDays: 5 } },
      {
        action: 'update',
        data: { defaultReminderLeadDays: 5, defaultStorageLocation: null },
      },
    ])
  })
})
