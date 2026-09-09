interface IAppOption {
  globalData: {
    pendingInventoryIntent: {
      viewStatus: import('./inventory').InventoryViewStatus
      source: 'home_card'
    } | null
    pendingBatchIntent: {
      source: 'home' | 'inventory' | 'trash'
      search?: string
      category?: import('./inventory').Category | ''
      viewStatus?: import('./inventory').InventoryViewStatus
    } | null
  }
}
