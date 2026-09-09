import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudServiceError } from '../../miniprogram/services/cloud-client'

const cloudMock = vi.hoisted(() => ({ callCloud: vi.fn() }))
vi.mock('../../miniprogram/services/cloud-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../miniprogram/services/cloud-client')>()
  return { ...actual, callCloud: cloudMock.callCloud }
})

const inventoryItem = (name: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  _id: `id-${name}`,
  name,
  quantity: 2,
  unit: '盒',
  category: 'food',
  storageLocation: '冰箱',
  expiryInputMode: 'direct',
  productionDate: null,
  shelfLifeValue: null,
  shelfLifeUnit: null,
  expiryDate: '2026-10-01',
  reminderLeadDays: 1,
  updatedAt,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.wx = { cloud: { callFunction: vi.fn() } } as never
})

describe('listRecentProfiles', () => {
  it('uses the dedicated cloud action when it exists', async () => {
    const { listRecentProfiles } = await import('../../miniprogram/services/quick-entry-service')
    cloudMock.callCloud.mockResolvedValueOnce({ items: [{ name: '牛奶' }] })
    const result = await listRecentProfiles()
    expect(cloudMock.callCloud).toHaveBeenCalledWith('inventoryApi', { action: 'listRecentProfiles' })
    expect(result.items).toHaveLength(1)
  })

  it('falls back to the inventory list when the cloud function is outdated', async () => {
    const { listRecentProfiles } = await import('../../miniprogram/services/quick-entry-service')
    cloudMock.callCloud
      .mockRejectedValueOnce(new CloudServiceError('INVALID_ACTION', '不支持的库存操作'))
      .mockResolvedValueOnce({
        items: [
          inventoryItem('酸奶', '2026-09-01T10:00:00Z'),
          inventoryItem('牛奶', '2026-09-08T10:00:00Z'),
          inventoryItem('牛奶', '2026-09-05T10:00:00Z'),
        ],
      })

    const result = await listRecentProfiles()

    expect(cloudMock.callCloud).toHaveBeenLastCalledWith('inventoryApi', expect.objectContaining({
      action: 'listInventory',
      viewStatus: 'active_all',
      sort: 'created_desc',
    }))
    expect(result.items.map((item) => item.name)).toEqual(['牛奶', '酸奶'])
    expect(result.items[0]).toMatchObject({ quantity: 2, unit: '盒', category: 'food', expiryInputMode: 'direct' })
  })

  it('surfaces other cloud errors instead of hiding them', async () => {
    const { listRecentProfiles } = await import('../../miniprogram/services/quick-entry-service')
    cloudMock.callCloud.mockRejectedValueOnce(new CloudServiceError('CLOUD_CALL_FAILED', '服务暂时不可用'))
    await expect(listRecentProfiles()).rejects.toThrow('服务暂时不可用')
    expect(cloudMock.callCloud).toHaveBeenCalledTimes(1)
  })
})
