import type { InventorySort } from '../types/inventory'

/**
 * 保存物品成功后回首页时，让首页按录入时间排序（新的在前），用户能立刻看到刚录入的物品。
 * 用全局 intent 而不是改默认排序：只影响「刚保存完」这一次回首页，不劫持用户自己选的排序。
 */
export function markPendingHomeSort(sort: InventorySort = 'created_desc') {
  try {
    const app = getApp<IAppOption>()
    if (app?.globalData) app.globalData.pendingHomeSortIntent = { sort }
  } catch (_error) {
    // 单测环境没有 getApp，忽略。
  }
}
