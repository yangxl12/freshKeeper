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

const RECENT_PAGE_SIZE = 30
const MAX_RECENT_ROUNDS = 12
// 攒够这个倍数就收手：物品不足 100 件时 cutoff 会被推到 -Infinity、循环条件恒真，
// 原来的写法会一路翻满 12 轮（24 次查询）。多攒 2 倍是为了给去重留出余量。
const RECENT_STOP_FACTOR = 2

function mergeRecentItems(rows, limit = 100) {
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

/**
 * 双状态翻页归并（fallback）。
 *
 * 只在拿不到「跨状态按 updatedAt 排序」的能力时使用：索引未建、或数据源按状态分开存放。
 * 最坏会翻 MAX_RECENT_ROUNDS × 2 次，所以加了提前退出（见 RECENT_STOP_FACTOR）。
 */
async function readRecentProfiles(fetchPage, limit = 100) {
  const states = ['active', 'used_up'].map(status => ({ status, offset: 0, done: false, lastTime: Infinity }))
  const rows = []
  const stopAt = limit * RECENT_STOP_FACTOR
  let cutoff = -Infinity
  let uniqueCount = 0
  let rounds = 0
  while (rounds < MAX_RECENT_ROUNDS && states.some(state => !state.done && state.lastTime >= cutoff)) {
    rounds += 1
    await Promise.all(states.filter(state => !state.done && state.lastTime >= cutoff).map(async state => {
      const page = await fetchPage(state.status, state.offset, RECENT_PAGE_SIZE)
      state.offset += page.length
      state.done = page.length < RECENT_PAGE_SIZE
      state.lastTime = page.length ? timestamp(page[page.length - 1].updatedAt) : -Infinity
      rows.push(...page)
    }))
    // 唯一名字数是单调不减的，可以增量维护；每轮只对新增部分排序再归并，
    // 避免原先「每轮全量重排累积 rows」的 O(rounds × n log n)。
    const incoming = rows.slice(Math.max(0, rows.length - RECENT_PAGE_SIZE * states.length))
    incoming.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    const unique = new Set()
    for (const row of [...incoming, ...rows.slice(0, rows.length - incoming.length)]
      .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))) {
      const key = normalizeRecentName(row.name)
      if (key) unique.add(key)
      if (unique.size >= limit) { cutoff = timestamp(row.updatedAt); break }
    }
    uniqueCount = unique.size
    if (uniqueCount >= stopAt) break
  }
  return { items: mergeRecentItems(rows, limit) }
}

/**
 * 最近录入档案（单次查询版，云函数主路径）。
 *
 * 跨 active / used_up 直接按 updatedAt 倒序取 limit 条，再做内存去重 —— 语义上比
 * 「双状态各自翻页再归并」更贴近「最近」，且把最坏 24 次查询压到 1 次。
 * 依赖索引 `ownerId ASC, updatedAt DESC`。
 */
async function readRecentProfilesOnce(fetchTop, limit = 100) {
  const rows = await fetchTop(limit)
  return { items: mergeRecentItems(rows || [], limit) }
}

module.exports = {
  mergeRecentItems,
  normalizeRecentName,
  toRecentProfile,
  readRecentProfiles,
  readRecentProfilesOnce,
}
