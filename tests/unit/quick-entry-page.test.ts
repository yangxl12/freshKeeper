import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { CloudServiceError } from '../../miniprogram/services/cloud-client'

const { listRecentProfilesMock } = vi.hoisted(() => ({
  listRecentProfilesMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/quick-entry-service', () => ({
  listRecentProfiles: listRecentProfilesMock,
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
