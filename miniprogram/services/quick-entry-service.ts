import type {
  QuickEntryCapabilities,
  QuickEntryParseResult,
  RecentItemProfile,
} from '../types/quick-entry'
import { parseQuickTextLocally, recentProfilesFromItems } from '../domain/quick-entry'
import { callCloud, CloudServiceError } from './cloud-client'
import type { InventoryItem } from '../types/inventory'

const LOCAL_TEXT_FALLBACK_CODES = new Set([
  'AI_UNAVAILABLE',
  'CLOUD_CALL_FAILED',
  'CLOUD_NOT_ENABLED',
  'INVALID_ACTION',
  'INVALID_RESPONSE',
  'QUICK_ENTRY_FAILED',
  'QUICK_ENTRY_TIMEOUT',
])

const RECENT_FALLBACK_PAGE_SIZE = 30

/** 旧部署没有 listRecentProfiles 时，用现有库存列表本地归并，保证最近使用可用。 */
async function listRecentProfilesFromInventory(limit: number): Promise<{ items: RecentItemProfile[] }> {
  const result = await callCloud<{ items: InventoryItem[] }>('inventoryApi', {
    action: 'listInventory',
    search: '',
    category: '',
    viewStatus: 'active_all',
    sort: 'created_desc',
    cursor: null,
    pageSize: Math.min(RECENT_FALLBACK_PAGE_SIZE, limit * 2),
  })
  return { items: recentProfilesFromItems(result.items || [], limit) }
}

export async function listRecentProfiles(limit = 100): Promise<{ items: RecentItemProfile[] }> {
  try {
    const result = await callCloud<{ items: RecentItemProfile[] }>('inventoryApi', { action: 'listRecentProfiles' })
    return { items: result.items.slice(0, limit) }
  } catch (error) {
    if (!(error instanceof CloudServiceError) || error.code !== 'INVALID_ACTION') throw error
    return listRecentProfilesFromInventory(limit)
  }
}

export function getQuickEntryCapabilities(): Promise<QuickEntryCapabilities> {
  return callCloud('quickEntryApi', { action: 'getCapabilities' })
}

export async function parseQuickText(text: string): Promise<QuickEntryParseResult> {
  try {
    return await callCloud('quickEntryApi', { action: 'parseText', text })
  } catch (error) {
    if (!(error instanceof CloudServiceError) || !LOCAL_TEXT_FALLBACK_CODES.has(error.code)) throw error
    return parseQuickTextLocally(text)
  }
}
