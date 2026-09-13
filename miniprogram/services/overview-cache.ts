import type { InventoryOverviewResult } from '../types/inventory'
import { shanghaiTodayKey } from '../utils/shanghai-time'

const OVERVIEW_STORAGE_KEY = 'home_overview_cache'

export interface OverviewCache {
  dateKey: string
  overview: InventoryOverviewResult
  at: number
}

let memoryCache: OverviewCache | null = null
let dirty = true

export function markOverviewDirty(): void {
  dirty = true
}

export function clearOverviewCache(): void {
  memoryCache = null
  dirty = true
  try {
    wx.removeStorageSync(OVERVIEW_STORAGE_KEY)
  } catch (_error) {
    // 注销和缓存清理不能被本地存储异常阻断。
  }
}

export function readOverviewCache(): OverviewCache | null {
  if (memoryCache) return memoryCache
  try {
    const stored = wx.getStorageSync(OVERVIEW_STORAGE_KEY) as OverviewCache | ''
    if (stored && typeof stored === 'object' && stored.overview && typeof stored.dateKey === 'string') {
      memoryCache = stored
    }
  } catch (_error) {
    // 缓存不可用时由首页正常请求云端。
  }
  return memoryCache
}

export function writeOverviewCache(overview: InventoryOverviewResult): void {
  const next = { dateKey: shanghaiTodayKey(), overview, at: Date.now() }
  memoryCache = next
  dirty = false
  try {
    wx.setStorageSync(OVERVIEW_STORAGE_KEY, next)
  } catch (_error) {
    // 持久化失败不影响当前会话内缓存。
  }
}

export function cachedOverviewUsable(dateKey: string): boolean {
  const cache = readOverviewCache()
  return Boolean(cache && !dirty && cache.dateKey === dateKey)
}
