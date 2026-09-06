import { describe, expect, it } from 'vitest'
import { getExpiryPresentation } from '../../miniprogram/domain/expiry'

describe('expiry presentation', () => {
  const today = '2026-09-06'

  it.each([
    ['2026-09-05', 'expired', -1, '已过期 1 天'],
    ['2026-09-06', 'due_today', 0, '今天到期'],
    ['2026-09-07', 'due_in_3_days', 1, '还有 1 天'],
    ['2026-09-09', 'due_in_3_days', 3, '还有 3 天'],
    ['2026-09-10', 'due_in_7_days', 4, '还有 4 天'],
    ['2026-09-13', 'due_in_7_days', 7, '还有 7 天'],
    ['2026-09-14', 'safe', 8, '暂时安全'],
  ] as const)('classifies %s', (date, status, daysLeft, text) => {
    expect(getExpiryPresentation(date, today)).toMatchObject({ status, daysLeft, text })
  })
})
