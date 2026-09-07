interface IAppOption {
  globalData: {
    pendingInventoryIntent: {
      viewStatus: import('./inventory').InventoryViewStatus
      source: 'home_card'
    } | null
  }
}
