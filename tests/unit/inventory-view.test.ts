import { describe, expect, it } from 'vitest'

import {
  HOME_CARD_VIEW_STATUS,
  hasActiveInventoryConditions,
} from '../../miniprogram/domain/inventory'

describe('inventory view filters', () => {
  it('maps every overview card to its inventory status', () => {
    expect(HOME_CARD_VIEW_STATUS).toEqual({
      activeTotal: 'active_all',
      expired: 'expired',
      expiringWithin7Days: 'expiring',
      usedUpTotal: 'used_up',
      safe: 'safe',
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
