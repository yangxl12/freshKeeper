'use strict'

const VALID_CATEGORIES = new Set(['food', 'medicine', 'household', 'other'])
const VALID_MODES = new Set(['direct', 'shelf_life'])
const VALID_UNITS = new Set(['day', 'month', 'year'])

function normalizeRecentName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z]/g, (letter) => letter.toLowerCase())
}

function timestamp(value) {
  if (!value) return 0
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(result) ? result : 0
}

function toRecentProfile(item) {
  const mode = VALID_MODES.has(item.expiryInputMode) ? item.expiryInputMode : 'direct'
  return {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    category: VALID_CATEGORIES.has(item.category) ? item.category : 'other',
    storageLocation: typeof item.storageLocation === 'string' ? item.storageLocation : '',
    reminderLeadDays: Number.isInteger(item.reminderLeadDays) ? item.reminderLeadDays : 1,
    expiryInputMode: mode,
    shelfLifeValue: mode === 'shelf_life' && Number.isInteger(item.shelfLifeValue) ? item.shelfLifeValue : null,
    shelfLifeUnit: mode === 'shelf_life' && VALID_UNITS.has(item.shelfLifeUnit) ? item.shelfLifeUnit : null,
  }
}

function mergeRecentItems(rows, limit = 6) {
  const sorted = [...rows].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
  const seen = new Set()
  const result = []
  for (const item of sorted) {
    const nameKey = normalizeRecentName(item.name)
    if (!nameKey || seen.has(nameKey)) continue
    seen.add(nameKey)
    result.push(toRecentProfile(item))
    if (result.length >= limit) break
  }
  return result
}

module.exports = { mergeRecentItems, normalizeRecentName, toRecentProfile }
