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
  const invalidFields = []
  const quantity = Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 9999 ? item.quantity : 1
  const unit = typeof item.unit === 'string' && item.unit.trim().length >= 1 && item.unit.trim().length <= 8 ? item.unit.trim() : '件'
  const category = VALID_CATEGORIES.has(item.category) ? item.category : 'food'
  const reminderLeadDays = Number.isInteger(item.reminderLeadDays) && item.reminderLeadDays >= 0 && item.reminderLeadDays <= 30 ? item.reminderLeadDays : 1
  if (quantity !== item.quantity) invalidFields.push('quantity')
  if (unit !== item.unit) invalidFields.push('unit')
  if (category !== item.category) invalidFields.push('category')
  if (reminderLeadDays !== item.reminderLeadDays) invalidFields.push('reminderLeadDays')
  const shelfLifeUnit = mode === 'shelf_life' && VALID_UNITS.has(item.shelfLifeUnit) ? item.shelfLifeUnit : mode === 'shelf_life' ? 'day' : null
  if (mode === 'shelf_life' && shelfLifeUnit !== item.shelfLifeUnit) invalidFields.push('shelfLifeUnit')
  return {
    name: typeof item.name === 'string' ? item.name : '',
    quantity,
    unit,
    category,
    storageLocation: typeof item.storageLocation === 'string' ? item.storageLocation : '',
    reminderLeadDays,
    expiryInputMode: mode,
    shelfLifeValue: mode === 'shelf_life' && Number.isInteger(item.shelfLifeValue) ? item.shelfLifeValue : null,
    shelfLifeUnit,
    invalidFields,
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

async function readRecentProfiles(fetchPage, limit = 6) {
  const states = ['active', 'used_up'].map(status => ({ status, offset: 0, done: false, lastTime: Infinity }))
  const rows = []
  let cutoff = -Infinity
  while (states.some(state => !state.done && state.lastTime >= cutoff)) {
    await Promise.all(states.filter(state => !state.done && state.lastTime >= cutoff).map(async state => {
      const page = await fetchPage(state.status, state.offset, 30)
      state.offset += page.length
      state.done = page.length < 30
      state.lastTime = page.length ? timestamp(page[page.length - 1].updatedAt) : -Infinity
      rows.push(...page)
    }))
    const unique = new Set()
    const sorted = [...rows].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    for (const row of sorted) {
      const key = normalizeRecentName(row.name)
      if (key) unique.add(key)
      if (unique.size >= limit) { cutoff = timestamp(row.updatedAt); break }
    }
  }
  return { items: mergeRecentItems(rows, limit) }
}

module.exports = { mergeRecentItems, normalizeRecentName, toRecentProfile, readRecentProfiles }
