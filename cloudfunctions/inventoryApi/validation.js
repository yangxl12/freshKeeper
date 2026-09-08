'use strict'

const { AppError, assert } = require('./error')
const { calculateExpiryDate } = require('./date')

const CATEGORIES = new Set(['food', 'medicine', 'household', 'other'])
const INPUT_MODES = new Set(['direct', 'shelf_life'])
const SHELF_LIFE_UNITS = new Set(['day', 'month', 'year'])
const HISTORY_STATUSES = new Set(['used_up', 'discarded'])
const INVENTORY_VIEW_STATUSES = new Set([
  'active_all',
  'expired',
  'expiring',
  'safe',
  'used_up',
])
const INVENTORY_SORTS = new Set([
  'expiry_asc',
  'expiry_desc',
  'created_asc',
  'created_desc',
])
const SAVE_FIELDS = new Set([
  'itemId',
  'version',
  'name',
  'quantity',
  'unit',
  'category',
  'storageLocation',
  'expiryInputMode',
  'productionDate',
  'shelfLifeValue',
  'shelfLifeUnit',
  'expiryDate',
  'reminderLeadDays',
])

function assertPlainObject(value, message = '请求参数不正确') {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_ARGUMENT',
    message,
  )
}

function assertNoClientIdentity(event) {
  assertPlainObject(event)
  const containers = [event, event.data].filter(Boolean)
  for (const container of containers) {
    if (typeof container !== 'object') continue
    for (const key of Object.keys(container)) {
      if (['ownerId', 'openid', 'openId', '_openid', 'templateId'].includes(key)) {
        throw new AppError('FORBIDDEN_FIELD', '请求包含不允许提交的字段')
      }
    }
  }
}

function validateSaveInput(input) {
  assertPlainObject(input, '物品信息不正确')
  for (const key of Object.keys(input)) {
    assert(SAVE_FIELDS.has(key), 'FORBIDDEN_FIELD', `物品字段 ${key} 不允许修改`)
  }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
  assert(name.length >= 1 && name.length <= 40, 'INVALID_ARGUMENT', '物品名称需为 1～40 个字符')
  assert(Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 9999, 'INVALID_ARGUMENT', '数量需为 1～9999 的整数')
  assert(unit.length >= 1 && unit.length <= 8, 'INVALID_ARGUMENT', '单位需为 1～8 个字符')
  assert(CATEGORIES.has(input.category), 'INVALID_ARGUMENT', '物品分类不正确')
  const storageLocation = input.storageLocation == null
    ? ''
    : typeof input.storageLocation === 'string'
      ? input.storageLocation.trim()
      : null
  assert(storageLocation !== null, 'INVALID_ARGUMENT', '存放位置不正确')
  assert(INPUT_MODES.has(input.expiryInputMode), 'INVALID_ARGUMENT', '到期录入方式不正确')
  assert(Number.isInteger(input.reminderLeadDays) && input.reminderLeadDays >= 0 && input.reminderLeadDays <= 30, 'INVALID_ARGUMENT', '提前提醒需为 0～30 天的整数')

  if (input.expiryInputMode === 'shelf_life') {
    assert(SHELF_LIFE_UNITS.has(input.shelfLifeUnit), 'INVALID_ARGUMENT', '保质期单位不正确')
  }

  const expiryDate = calculateExpiryDate(input)
  return {
    name,
    searchName: name.toLocaleLowerCase('zh-CN'),
    quantity: input.quantity,
    unit,
    category: input.category,
    storageLocation,
    expiryInputMode: input.expiryInputMode,
    productionDate: input.expiryInputMode === 'shelf_life' ? input.productionDate : null,
    shelfLifeValue: input.expiryInputMode === 'shelf_life' ? input.shelfLifeValue : null,
    shelfLifeUnit: input.expiryInputMode === 'shelf_life' ? input.shelfLifeUnit : null,
    expiryDate,
    reminderLeadDays: input.reminderLeadDays,
  }
}

function validateIdempotencyKey(value) {
  assert(
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'INVALID_ARGUMENT',
    '快速录入请求编号不正确',
  )
  return value.toLowerCase()
}

function validateItemId(value) {
  assert(typeof value === 'string' && value.length >= 1 && value.length <= 128, 'INVALID_ARGUMENT', '物品编号不正确')
  return value
}

function validateVersion(value) {
  assert(Number.isInteger(value) && value >= 1, 'INVALID_ARGUMENT', '记录版本不正确')
  return value
}

function validateDecrementAmount(value) {
  if (value === undefined || value === null) return 1
  assert(Number.isInteger(value) && value >= 1 && value <= 9999, 'INVALID_ARGUMENT', '减少数量需为 1～9999 的整数')
  return value
}

function validateBatchItems(value) {
  assert(Array.isArray(value) && value.length >= 1 && value.length <= 20, 'INVALID_ARGUMENT', '每批需选择 1～20 条物品')
  const seen = new Set()
  return value.map((item) => {
    assertPlainObject(item, '批量物品信息不正确')
    const itemId = validateItemId(item.itemId)
    const version = validateVersion(item.version)
    assert(!seen.has(itemId), 'INVALID_ARGUMENT', '批量物品不能重复')
    seen.add(itemId)
    return { itemId, version }
  })
}

function validatePageSize(value) {
  if (value === undefined || value === null) return 30
  assert(Number.isInteger(value) && value >= 1 && value <= 30, 'INVALID_ARGUMENT', '分页大小不正确')
  return value
}

function validateSearch(value) {
  if (value === undefined || value === null) return ''
  assert(typeof value === 'string', 'INVALID_ARGUMENT', '搜索词不正确')
  const search = value.trim().toLocaleLowerCase('zh-CN')
  assert(search.length <= 40, 'INVALID_ARGUMENT', '搜索词不能超过 40 个字符')
  return search
}

function validateOptionalCategory(value) {
  if (!value) return ''
  assert(CATEGORIES.has(value), 'INVALID_ARGUMENT', '物品分类不正确')
  return value
}

function validateOptionalStorage(value) {
  if (value == null || value === '') return ''
  assert(typeof value === 'string', 'INVALID_ARGUMENT', '存放位置不正确')
  return value.trim()
}

function validateHistoryStatus(value) {
  if (!value) return ''
  assert(HISTORY_STATUSES.has(value), 'INVALID_ARGUMENT', '历史状态不正确')
  return value
}

function validateInventoryViewStatus(value) {
  if (value === undefined || value === null || value === '') return 'active_all'
  assert(INVENTORY_VIEW_STATUSES.has(value), 'INVALID_ARGUMENT', '库存状态不正确')
  return value
}

function validateInventorySort(value) {
  if (value === undefined || value === null || value === '') return 'expiry_asc'
  assert(INVENTORY_SORTS.has(value), 'INVALID_ARGUMENT', '排序方式不正确')
  return value
}

module.exports = {
  assertNoClientIdentity,
  validateHistoryStatus,
  validateInventorySort,
  validateBatchItems,
  validateDecrementAmount,
  validateInventoryViewStatus,
  validateItemId,
  validateIdempotencyKey,
  validateOptionalCategory,
  validateOptionalStorage,
  validatePageSize,
  validateSaveInput,
  validateSearch,
  validateVersion,
}
