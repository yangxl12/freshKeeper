interface IAppOption {
  globalData: {
    pendingQuickFormDraft: Partial<import('./inventory').InventorySaveInput> | null
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
