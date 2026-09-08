'use strict'

const { assert, fail } = require('./validation')

const CATEGORIES = new Set(['food', 'medicine', 'household', 'other'])
const DATE_ROLES = new Set(['expiry', 'production', 'unknown'])
const SHELF_UNITS = new Set(['day', 'month', 'year'])

function currentDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function dateKey(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null
  if (year < 1900 || year > 2200) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10)
}

function nearestMonthDay(today, month, day) {
  const year = Number(today.slice(0, 4))
  for (let next = year; next <= year + 8; next++) {
    const candidate = dateKey(next, month, day)
    if (candidate && candidate >= today) return candidate
  }
  return null
}

function parseDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const normalized = dateKey(year, month, day)
  return normalized === value ? normalized : null
}

function safeText(value, max, field) {
  if (value == null) return undefined
  assert(typeof value === 'string' && value.trim().length <= max, 'INVALID_PROVIDER_RESPONSE', `${field}格式不正确`)
  return value.trim()
}

function normalizeFacts(facts, source, today) {
  assert(Array.isArray(facts), 'INVALID_PROVIDER_RESPONSE', '日期事实格式不正确')
  assert(facts.length <= 12, 'INVALID_PROVIDER_RESPONSE', '日期候选过多')
  return facts.filter((fact) => fact && typeof fact === 'object').map((fact) => {
    const rawText = safeText(fact.rawText || '', 120, '日期原文') || ''
    const role = DATE_ROLES.has(fact.label) ? fact.label : fact.kind === 'expiry' ? 'expiry' : fact.kind === 'production' ? 'production' : 'unknown'
    let value = null
    if (source === 'text' && fact.kind === 'relative' && role !== 'unknown' && Number.isInteger(fact.offsetDays) && Math.abs(fact.offsetDays) <= 3650) {
      value = addDays(today, fact.offsetDays)
    } else if (Number.isInteger(fact.year) && Number.isInteger(fact.month) && Number.isInteger(fact.day)) {
      value = dateKey(fact.year, fact.month, fact.day)
    } else if (source === 'text' && role !== 'production' && !fact.year && Number.isInteger(fact.month) && Number.isInteger(fact.day)) {
      value = nearestMonthDay(today, fact.month, fact.day)
    }
    return { date: value, role, rawText, complete: Boolean(value), source }
  })
}

function providerBody(payload) {
  return payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object' ? payload.data : payload
}

function normalizeTextResult(payload, today = currentDateKey()) {
  const body = providerBody(payload)
  assert(body && Array.isArray(body.items), 'INVALID_PROVIDER_RESPONSE', '文字识别结果格式不正确')
  if (body.items.length > 5) fail('TOO_MANY_DRAFTS', '一次最多生成 5 条草稿，请分次录入')
  assert(body.items.length >= 1, 'INVALID_PROVIDER_RESPONSE', '没有识别出物品')
  const items = body.items.map((item) => {
    assert(item && typeof item === 'object', 'INVALID_PROVIDER_RESPONSE', '物品候选格式不正确')
    const quantity = item.quantity == null ? undefined : item.quantity
    assert(quantity === undefined || (Number.isInteger(quantity) && quantity >= 1 && quantity <= 9999), 'INVALID_PROVIDER_RESPONSE', '数量候选不正确')
    const category = item.category == null ? undefined : item.category
    assert(category === undefined || CATEGORIES.has(category), 'INVALID_PROVIDER_RESPONSE', '分类候选不正确')
    const dateFacts = Array.isArray(item.dateFacts) ? item.dateFacts : []
    const shelfFact = dateFacts.find((fact) => fact?.kind === 'shelf_life')
    if (shelfFact) {
      assert(Number.isInteger(shelfFact.value) && shelfFact.value > 0 && SHELF_UNITS.has(shelfFact.unit), 'INVALID_PROVIDER_RESPONSE', '保质期候选不正确')
    }
    return {
      name: safeText(item.name, 40, '名称'),
      quantity,
      unit: safeText(item.unit, 8, '单位'),
      category,
      storageLocation: safeText(item.storageLocation, 500, '存放位置'),
      expiryInputMode: shelfFact ? 'shelf_life' : undefined,
      shelfLifeValue: shelfFact?.value,
      shelfLifeUnit: shelfFact?.unit,
      dateCandidates: normalizeFacts(dateFacts.filter((fact) => fact?.kind !== 'shelf_life'), 'text', today),
    }
  })
  return { items, serverToday: today, parserVersion: safeText(body.parserVersion, 40, '解析版本') || 'provider-v1' }
}

function normalizePhotoResult(payload, today = currentDateKey()) {
  const body = providerBody(payload)
  assert(body && typeof body === 'object', 'INVALID_PROVIDER_RESPONSE', '日期识别结果格式不正确')
  const unsupported = body.unsupported === 'opened_period' ? 'opened_period' : undefined
  const shelfFact = Array.isArray(body.dateFacts) ? body.dateFacts.find(fact => fact?.kind === 'shelf_life') : undefined
  const shelfLifeValue = shelfFact?.value ?? body.shelfLifeValue
  const shelfLifeUnit = shelfFact?.unit ?? body.shelfLifeUnit
  if (shelfLifeValue != null) assert(Number.isInteger(shelfLifeValue) && shelfLifeValue > 0 && SHELF_UNITS.has(shelfLifeUnit), 'INVALID_PROVIDER_RESPONSE', '保质期候选不正确')
  let candidates
  if (Array.isArray(body.candidates)) {
    assert(body.candidates.length <= 12, 'INVALID_PROVIDER_RESPONSE', '日期候选过多')
    candidates = body.candidates.map((candidate) => {
      assert(candidate && DATE_ROLES.has(candidate.role), 'INVALID_PROVIDER_RESPONSE', '日期候选角色不正确')
      const value = parseDateString(candidate.date)
      return { date: value, role: candidate.role, rawText: safeText(candidate.rawText || '', 120, '日期原文') || '', complete: Boolean(value && candidate.complete !== false), source: 'photo' }
    })
  } else {
    candidates = normalizeFacts(Array.isArray(body.dateFacts) ? body.dateFacts.filter(fact => fact?.kind !== 'shelf_life') : [], 'photo', today)
  }
  if (!candidates.length && !unsupported && !shelfLifeValue) fail('OCR_NO_DATE', '没有识别到完整日期，请重拍或手动选择')
  return { candidates, unsupported, shelfLifeValue, shelfLifeUnit, sourceText: safeText(body.sourceText, 2000, '识别原文'), serverToday: today }
}

module.exports = { currentDateKey, normalizePhotoResult, normalizeTextResult }
