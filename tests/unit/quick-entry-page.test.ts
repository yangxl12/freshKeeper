import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { CloudServiceError } from '../../miniprogram/services/cloud-client'

const { getQuickEntryCapabilitiesMock, getSettingsMock, listRecentProfilesMock } = vi.hoisted(() => ({
  getQuickEntryCapabilitiesMock: vi.fn(),
  getSettingsMock: vi.fn(),
  listRecentProfilesMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/quick-entry-service', () => ({
  getQuickEntryCapabilities: getQuickEntryCapabilitiesMock,
  listRecentProfiles: listRecentProfilesMock,
}))

vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
}))

const originalPage = globalThis.Page
let quickEntryPage: Record<string, unknown>

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    quickEntryPage = definition
  }) as never
  await import('../../miniprogram/pages/quick-entry/index')
})

afterAll(() => {
  globalThis.Page = originalPage
})

describe('quick entry page compatibility', () => {
  it('keeps local text entry visible when remote recognition is not configured', async () => {
    listRecentProfilesMock.mockResolvedValueOnce({ items: [] })
    getQuickEntryCapabilitiesMock.mockResolvedValueOnce({ text: false, voice: false, datePhoto: false })
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 2 })
    const setData = vi.fn()
    const openManual = vi.fn()

    await (quickEntryPage.preparePage as () => Promise<void>).call({
      setData,
      openManual,
    })

    expect(openManual).not.toHaveBeenCalled()
    expect(setData).toHaveBeenCalledWith(expect.objectContaining({
      loading: false,
      features: { recent: true, text: true, voice: true, datePhoto: true },
      capabilities: { text: true, voice: false, datePhoto: false },
      defaultReminderLeadDays: 2,
    }))
  })

  it('stays on quick entry and explains when the cloud function is outdated', async () => {
    listRecentProfilesMock.mockRejectedValueOnce(
      new CloudServiceError('INVALID_ACTION', '不支持的库存操作'),
    )
    const setData = vi.fn()
    const openManual = vi.fn()

    await (quickEntryPage.loadRecentProfiles as () => Promise<void>).call({
      setData,
      openManual,
    })

    expect(openManual).not.toHaveBeenCalled()
    expect(setData).toHaveBeenCalledWith({
      loading: false,
      loadingError: '快速录入服务尚未更新，请先使用完整填写',
    })
  })
})
