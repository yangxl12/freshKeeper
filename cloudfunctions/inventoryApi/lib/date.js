'use strict'

const { AppError } = require('./error')

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MILLIS_PER_DAY = 86_400_000

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function parseDateKey(value) {
  if (typeof value !== 'string') return null
  const match = DATE_KEY_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function formatDateKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`
}

function toDayOrdinal(value) {
  const parts = parseDateKey(value)
  if (!parts) throw new AppError('INVALID_ARGUMENT', '日期格式不正确')
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY)
}

function fromDayOrdinal(ordinal) {
  const date = new Date(ordinal * MILLIS_PER_DAY)
  return formatDateKey({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  })
}

function addDays(value, amount) {
  return fromDayOrdinal(toDayOrdinal(value) + amount)
}

function addCalendarMonths(value, amount) {
  const parts = parseDateKey(value)
  if (!parts) throw new AppError('INVALID_ARGUMENT', '生产日期格式不正确')
  const monthIndex = parts.year * 12 + parts.month - 1 + amount
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12 + 1
  return formatDateKey({
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month)),
  })
}

function addCalendarYears(value, amount) {
  const parts = parseDateKey(value)
  if (!parts) throw new AppError('INVALID_ARGUMENT', '生产日期格式不正确')
  const year = parts.year + amount
  return formatDateKey({
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  })
}

function calculateExpiryDate(input) {
  if (input.expiryInputMode === 'direct') {
    if (!parseDateKey(input.expiryDate)) {
      throw new AppError('INVALID_ARGUMENT', '请选择有效的到期日期')
    }
    return input.expiryDate
  }

  if (!parseDateKey(input.productionDate)) {
    throw new AppError('INVALID_ARGUMENT', '请选择有效的生产日期')
  }
  if (!Number.isInteger(input.shelfLifeValue) || input.shelfLifeValue <= 0) {
    throw new AppError('INVALID_ARGUMENT', '保质期需为正整数')
  }
  let result = ''
  if (input.shelfLifeUnit === 'day') {
    result = addDays(input.productionDate, input.shelfLifeValue)
  } else if (input.shelfLifeUnit === 'month') {
    result = addCalendarMonths(input.productionDate, input.shelfLifeValue)
  } else if (input.shelfLifeUnit === 'year') {
    result = addCalendarYears(input.productionDate, input.shelfLifeValue)
  } else {
    throw new AppError('INVALID_ARGUMENT', '保质期单位不正确')
  }
  if (!parseDateKey(result)) {
    throw new AppError('INVALID_ARGUMENT', '计算后的到期日期超出支持范围')
  }
  return result
}

function currentDateKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function getExpiryPresentation(expiryDate, today) {
  const daysLeft = toDayOrdinal(expiryDate) - toDayOrdinal(today)
  if (daysLeft < 0) {
    return {
      expiryStatus: 'expired',
      daysLeft,
      expiryStatusText: `已过期 ${Math.abs(daysLeft)} 天`,
      expiryTone: 'danger',
    }
  }
  if (daysLeft === 0) {
    return {
      expiryStatus: 'due_today',
      daysLeft,
      expiryStatusText: '今天到期',
      expiryTone: 'urgent',
    }
  }
  if (daysLeft <= 3) {
    return {
      expiryStatus: 'due_in_3_days',
      daysLeft,
      expiryStatusText: `还有 ${daysLeft} 天`,
      expiryTone: 'urgent',
    }
  }
  if (daysLeft <= 7) {
    return {
      expiryStatus: 'due_in_7_days',
      daysLeft,
      expiryStatusText: `还有 ${daysLeft} 天`,
      expiryTone: 'warning',
    }
  }
  return {
    expiryStatus: 'safe',
    daysLeft,
    expiryStatusText: '暂时安全',
    expiryTone: 'safe',
  }
}

module.exports = {
  addCalendarMonths,
  addCalendarYears,
  addDays,
  calculateExpiryDate,
  currentDateKey,
  getExpiryPresentation,
  parseDateKey,
  toDayOrdinal,
}
