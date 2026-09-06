import type { ExpiryInputMode, ShelfLifeUnit } from '../types/inventory'

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MILLIS_PER_DAY = 86_400_000

export interface DateParts {
  year: number
  month: number
  day: number
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function parseDateKey(value: string): DateParts | null {
  const match = DATE_KEY_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

export function formatDateKey(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(
    2,
    '0',
  )}-${String(parts.day).padStart(2, '0')}`
}

export function toDayOrdinal(value: string): number {
  const parts = parseDateKey(value)
  if (!parts) throw new Error('INVALID_DATE_KEY')
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY)
}

export function fromDayOrdinal(ordinal: number): string {
  const date = new Date(ordinal * MILLIS_PER_DAY)
  return formatDateKey({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  })
}

export function addDays(value: string, amount: number): string {
  return fromDayOrdinal(toDayOrdinal(value) + amount)
}

export function addCalendarMonths(value: string, amount: number): string {
  const parts = parseDateKey(value)
  if (!parts) throw new Error('INVALID_DATE_KEY')

  const monthIndex = parts.year * 12 + (parts.month - 1) + amount
  const year = Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12 + 1
  return formatDateKey({
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month)),
  })
}

export function addCalendarYears(value: string, amount: number): string {
  const parts = parseDateKey(value)
  if (!parts) throw new Error('INVALID_DATE_KEY')
  const year = parts.year + amount
  return formatDateKey({
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  })
}

export function calculateExpiryDate(input: {
  mode: ExpiryInputMode
  expiryDate?: string | null
  productionDate?: string | null
  shelfLifeValue?: number | null
  shelfLifeUnit?: ShelfLifeUnit | null
}): string {
  if (input.mode === 'direct') {
    if (!input.expiryDate || !parseDateKey(input.expiryDate)) {
      throw new Error('INVALID_EXPIRY_DATE')
    }
    return input.expiryDate
  }

  const { productionDate, shelfLifeValue, shelfLifeUnit } = input
  if (!productionDate || !parseDateKey(productionDate)) {
    throw new Error('INVALID_PRODUCTION_DATE')
  }
  if (!Number.isInteger(shelfLifeValue) || Number(shelfLifeValue) <= 0) {
    throw new Error('INVALID_SHELF_LIFE')
  }

  let result = ''
  if (shelfLifeUnit === 'day') result = addDays(productionDate, Number(shelfLifeValue))
  else if (shelfLifeUnit === 'month') {
    result = addCalendarMonths(productionDate, Number(shelfLifeValue))
  } else if (shelfLifeUnit === 'year') {
    result = addCalendarYears(productionDate, Number(shelfLifeValue))
  } else throw new Error('INVALID_SHELF_LIFE_UNIT')

  if (!parseDateKey(result)) throw new Error('INVALID_EXPIRY_DATE')
  return result
}

export function localTodayKey(now = new Date()): string {
  return formatDateKey({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  })
}
