interface IAppOption {
  globalData: {
    pendingInventoryIntent: {
      viewStatus: import('./inventory').InventoryViewStatus
      source: 'home_card'
    } | null
    /** 保存成功后回首页时生效的一次性排序意图，首页 onShow 消费后清空。 */
    pendingHomeSortIntent: {
      sort: import('./inventory').InventorySort
    } | null
    pendingBatchIntent: {
      source: 'home' | 'inventory' | 'trash'
      search?: string
      category?: import('./inventory').Category | ''
      viewStatus?: import('./inventory').InventoryViewStatus
    } | null
  }
}
