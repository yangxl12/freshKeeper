import { describe, expect, it } from 'vitest'

import {
  HOME_CARD_VIEW_STATUS,
  hasActiveInventoryConditions,
  toInventoryCardItem,
} from '../../miniprogram/domain/inventory'
import type { InventoryItem } from '../../miniprogram/types/inventory'

describe('inventory view filters', () => {
  it('maps every overview card to its inventory status', () => {
    expect(HOME_CARD_VIEW_STATUS).toEqual({
      activeTotal: 'active_all',
      expired: 'expired',
      expiringWithin7Days: 'expiring',
      usedUpTotal: 'used_up',
    })
  })

  it('formats the four fields used by inventory cards', () => {
    const item = {
      expiryDate: '2026-09-10',
      daysLeft: 3,
    } as InventoryItem
    expect(toInventoryCardItem(item)).toMatchObject({
      expiryDateText: '2026年09月10日',
      remainingDaysText: '剩余 3 天',
    })
  })

  it('only treats non-default search, category or status as active conditions', () => {
    expect(hasActiveInventoryConditions('', '', 'active_all')).toBe(false)
    expect(hasActiveInventoryConditions('   ', '', 'active_all')).toBe(false)
    expect(hasActiveInventoryConditions('牛奶', '', 'active_all')).toBe(true)
    expect(hasActiveInventoryConditions('', 'food', 'active_all')).toBe(true)
    expect(hasActiveInventoryConditions('', '', 'used_up')).toBe(true)
  })
})
