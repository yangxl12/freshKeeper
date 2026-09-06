'use strict'

function getDecrementDecision(inventoryStatus, quantity) {
  if (inventoryStatus !== 'active' || !Number.isInteger(quantity) || quantity < 1) {
    return 'invalid_state'
  }
  return quantity === 1 ? 'requires_completion' : 'decrement'
}

function canTransitionInventory(inventoryStatus, targetStatus) {
  return inventoryStatus === 'active' && ['used_up', 'discarded'].includes(targetStatus)
}

module.exports = { canTransitionInventory, getDecrementDecision }
