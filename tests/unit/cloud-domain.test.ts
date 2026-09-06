import { describe, expect, it } from 'vitest'

const cloudDate = require('../../cloudfunctions/inventoryApi/date') as {
  calculateExpiryDate(input: Record<string, unknown>): string
  getExpiryPresentation(expiryDate: string, today: string): {
    expiryStatus: string
    daysLeft: number
  }
  parseDateKey(value: string): unknown
}
const validation = require('../../cloudfunctions/inventoryApi/validation') as {
  validateSaveInput(input: Record<string, unknown>): Record<string, unknown>
  validateSearch(value: unknown): string
}
const reminderRules = require('../../cloudfunctions/reminderApi/rules') as {
  canArmReminder(status?: string): boolean
  canCancelReminder(status?: string): boolean
  isTerminalReminderStatus(status?: string): boolean
}
const inventoryRules = require('../../cloudfunctions/inventoryApi/rules') as {
  getDecrementDecision(status: string, quantity: number): string
  canTransitionInventory(status: string, target: string): boolean
}
const reminderTemplate = require('../../cloudfunctions/dispatchReminders/template') as {
  buildReminderTemplateData(
    item: { name: string; expiryDate: string; quantity: number },
    daysLeft: number,
    fields: Record<string, string>,
  ): Record<string, { value: string }>
}

function validSaveInput() {
  return {
    name: ' 鲜牛奶 ',
    quantity: 2,
    unit: '盒',
    category: 'food',
    storageLocation: 'refrigerated',
    expiryInputMode: 'direct',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: '2026-09-08',
    reminderLeadDays: 3,
  }
}

describe('cloud inventory domain', () => {
  it('uses calendar arithmetic on the server', () => {
    expect(
      cloudDate.calculateExpiryDate({
        expiryInputMode: 'shelf_life',
        productionDate: '2024-01-31',
        shelfLifeValue: 1,
        shelfLifeUnit: 'month',
      }),
    ).toBe('2024-02-29')
    expect(() =>
      cloudDate.calculateExpiryDate({
        expiryInputMode: 'shelf_life',
        productionDate: '2199-01-01',
        shelfLifeValue: 2,
        shelfLifeUnit: 'year',
      }),
    ).toThrow(/超出支持范围/)
  })

  it('classifies natural-day boundaries on the server', () => {
    expect(cloudDate.getExpiryPresentation('2026-09-05', '2026-09-06')).toMatchObject({
      expiryStatus: 'expired',
      daysLeft: -1,
    })
    expect(cloudDate.getExpiryPresentation('2026-09-14', '2026-09-06')).toMatchObject({
      expiryStatus: 'safe',
      daysLeft: 8,
    })
  })

  it('normalizes and validates the save whitelist', () => {
    expect(validation.validateSaveInput(validSaveInput())).toMatchObject({
      name: '鲜牛奶',
      searchName: '鲜牛奶',
      expiryDate: '2026-09-08',
    })
    expect(() =>
      validation.validateSaveInput({ ...validSaveInput(), ownerId: 'forged' }),
    ).toThrow(/不允许修改/)
    expect(() =>
      validation.validateSaveInput({ ...validSaveInput(), category: 'unknown' }),
    ).toThrow(/分类/)
  })

  it('escapes empty search semantics and limits search length', () => {
    expect(validation.validateSearch('  Milk  ')).toBe('milk')
    expect(() => validation.validateSearch('x'.repeat(41))).toThrow(/40/)
  })
})

describe('reminder states', () => {
  it('maps the configured reminder template fields', () => {
    expect(
      reminderTemplate.buildReminderTemplateData(
        { name: '鲜牛奶', expiryDate: '2026-09-09', quantity: 2 },
        3,
        {
          itemField: 'thing7',
          dateField: 'time2',
          remainingDaysField: 'number5',
          quantityField: 'number4',
          noteField: 'thing3',
        },
      ),
    ).toEqual({
      thing7: { value: '鲜牛奶' },
      time2: { value: '2026年9月9日' },
      number5: { value: '3' },
      number4: { value: '2' },
      thing3: { value: '还有3天到期' },
    })
  })

  it('only rearms explicitly unsent terminal outcomes', () => {
    expect(reminderRules.canArmReminder()).toBe(true)
    expect(reminderRules.canArmReminder('failed')).toBe(true)
    expect(reminderRules.canArmReminder('cancelled')).toBe(true)
    expect(reminderRules.canArmReminder('sent')).toBe(false)
    expect(reminderRules.canArmReminder('unknown')).toBe(false)
  })

  it('keeps sending, sent and unknown states terminal', () => {
    expect(reminderRules.isTerminalReminderStatus('sending')).toBe(true)
    expect(reminderRules.isTerminalReminderStatus('sent')).toBe(true)
    expect(reminderRules.isTerminalReminderStatus('unknown')).toBe(true)
    expect(reminderRules.canCancelReminder('scheduled')).toBe(true)
    expect(reminderRules.canCancelReminder('sent')).toBe(false)
  })
})

describe('inventory state transitions', () => {
  it('requires completion when decrementing the last active unit', () => {
    expect(inventoryRules.getDecrementDecision('active', 2)).toBe('decrement')
    expect(inventoryRules.getDecrementDecision('active', 1)).toBe('requires_completion')
    expect(inventoryRules.getDecrementDecision('discarded', 2)).toBe('invalid_state')
  })

  it('only lets active inventory enter a supported terminal state', () => {
    expect(inventoryRules.canTransitionInventory('active', 'used_up')).toBe(true)
    expect(inventoryRules.canTransitionInventory('active', 'discarded')).toBe(true)
    expect(inventoryRules.canTransitionInventory('used_up', 'discarded')).toBe(false)
    expect(inventoryRules.canTransitionInventory('active', 'deleted')).toBe(false)
  })
})
