import { describe, expect, it } from 'vitest'
import {
  addCalendarMonths,
  addCalendarYears,
  addDays,
  calculateExpiryDate,
  parseDateKey,
  toDayOrdinal,
} from '../../miniprogram/utils/date-key'

describe('date-key', () => {
  it('strictly validates natural dates', () => {
    expect(parseDateKey('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 })
    expect(parseDateKey('2026-2-28')).toBeNull()
    expect(parseDateKey('2025-02-29')).toBeNull()
    expect(parseDateKey('2024-02-29')).not.toBeNull()
    expect(parseDateKey('2026-13-01')).toBeNull()
  })

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(toDayOrdinal('2026-09-07') - toDayOrdinal('2026-09-06')).toBe(1)
  })

  it('clamps calendar month and year additions', () => {
    expect(addCalendarMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addCalendarMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addCalendarYears('2024-02-29', 1)).toBe('2025-02-28')
  })

  it('calculates both supported expiry input modes', () => {
    expect(calculateExpiryDate({ mode: 'direct', expiryDate: '2026-10-01' })).toBe(
      '2026-10-01',
    )
    expect(
      calculateExpiryDate({
        mode: 'shelf_life',
        productionDate: '2026-01-31',
        shelfLifeValue: 1,
        shelfLifeUnit: 'month',
      }),
    ).toBe('2026-02-28')
    expect(() =>
      calculateExpiryDate({
        mode: 'shelf_life',
        productionDate: '2199-01-01',
        shelfLifeValue: 2,
        shelfLifeUnit: 'year',
      }),
    ).toThrow('INVALID_EXPIRY_DATE')
  })
})
