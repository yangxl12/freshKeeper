'use strict'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function toTime(value) {
  if (!value) return Number.NaN
  const date = value instanceof Date ? value : new Date(value)
  return date.getTime()
}

function shouldPurgeTrash(item, now = new Date()) {
  if (!item || item.inventoryStatus !== 'deleted') return false
  const purgeTime = toTime(item.purgeAfter)
  return Number.isFinite(purgeTime) && purgeTime <= toTime(now)
}

module.exports = { RETENTION_MS, shouldPurgeTrash }
