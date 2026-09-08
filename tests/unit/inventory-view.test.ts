import { describe, expect, it } from 'vitest'

import {
  HOME_CARD_VIEW_STATUS,
  hasActiveInventoryConditions,
  parseQuantity,
  sanitizeQuantityInput,
  stepQuantity,
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

  it('exposes quantity, location and active state for the new card', () => {
    const item = {
      expiryDate: '2026-09-10',
      daysLeft: 3,
      quantity: 2,
      unit: '盒',
      storageLocation: 'refrigerated',
      storageLabel: '冷藏',
      inventoryStatus: 'active',
    } as InventoryItem
    const card = toInventoryCardItem(item)
    expect(card.quantityText).toBe('2盒')
    expect(card.locationText).toBe('冷藏')
    expect(card.hasLocation).toBe(true)
    expect(card.isActive).toBe(true)

    const withoutLocation = toInventoryCardItem({
      ...item,
      storageLocation: '',
      storageLabel: '未填写',
    } as InventoryItem)
    expect(withoutLocation.hasLocation).toBe(false)
    expect(withoutLocation.locationText).toBe('')
  })

  it('only treats non-default search, category or status as active conditions', () => {
    expect(hasActiveInventoryConditions('', '', 'active_all')).toBe(false)
    expect(hasActiveInventoryConditions('   ', '', 'active_all')).toBe(false)
    expect(hasActiveInventoryConditions('牛奶', '', 'active_all')).toBe(true)
    expect(hasActiveInventoryConditions('', 'food', 'active_all')).toBe(true)
    expect(hasActiveInventoryConditions('', '', 'used_up')).toBe(true)
  })

  it('keeps quantity input a positive integer within bounds', () => {
    expect(sanitizeQuantityInput('12ab')).toBe('12')
    expect(sanitizeQuantityInput('-3')).toBe('3')
    expect(sanitizeQuantityInput('007')).toBe('7')
    expect(sanitizeQuantityInput('12345')).toBe('1234')
    expect(parseQuantity('0')).toBeNull()
    expect(parseQuantity('')).toBeNull()
    expect(parseQuantity('12.5')).toBeNull()
    expect(parseQuantity('9999')).toBe(9999)
    expect(stepQuantity(1, -1)).toBe(1)
    expect(stepQuantity(3, -1)).toBe(2)
    expect(stepQuantity(9999, 1)).toBe(9999)
  })
})
