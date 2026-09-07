'use strict'

function getDecrementDecision(inventoryStatus, quantity, amount = 1) {
  if (
    inventoryStatus !== 'active' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > quantity
  ) {
    return 'invalid_state'
  }
  return amount === quantity ? 'requires_completion' : 'decrement'
}

function canTransitionInventory(inventoryStatus, targetStatus) {
  return inventoryStatus === 'active' && targetStatus === 'used_up'
}

function getOverviewBucket(inventoryStatus, expiryDate, today, expiringEnd) {
  if (inventoryStatus === 'used_up') return 'used_up'
  if (inventoryStatus !== 'active') return null
  if (expiryDate < today) return 'expired'
  if (expiryDate <= expiringEnd) return 'expiring'
  return 'safe'
}

function summarizeOverviewRows(rows) {
  const totals = { expired: 0, expiring: 0, safe: 0, used_up: 0 }
  for (const row of rows || []) {
    if (Object.prototype.hasOwnProperty.call(totals, row?._id) && Number.isFinite(row.total)) {
      totals[row._id] = row.total
    }
  }
  return {
    activeTotal: totals.expired + totals.expiring + totals.safe,
    expired: totals.expired,
    expiringWithin7Days: totals.expiring,
    usedUpTotal: totals.used_up,
    safe: totals.safe,
  }
}

module.exports = {
  canTransitionInventory,
  getDecrementDecision,
  getOverviewBucket,
  summarizeOverviewRows,
}
