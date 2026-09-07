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
  validateInventoryViewStatus(value: unknown): string
  validateDecrementAmount(value: unknown): number
  validateBatchItems(value: unknown): Array<{ itemId: string; version: number }>
}
const reminderRules = require('../../cloudfunctions/reminderApi/rules') as {
  canArmReminder(status?: string): boolean
  canCancelReminder(status?: string): boolean
  isTerminalReminderStatus(status?: string): boolean
}
const inventoryRules = require('../../cloudfunctions/inventoryApi/rules') as {
  getDecrementDecision(status: string, quantity: number): string
  canMoveInventoryToTrash(status: string): boolean
  canTransitionInventory(status: string, target: string): boolean
  getOverviewBucket(status: string, expiryDate: string, today: string, end: string): string | null
  summarizeOverviewRows(rows: Array<{ _id: string; total: number }>): Record<string, number>
}
const reminderTemplate = require('../../cloudfunctions/dispatchReminders/template') as {
  buildReminderTemplateData(
    item: { name: string; expiryDate: string; quantity: number },
    daysLeft: number,
    fields: Record<string, string>,
  ): Record<string, { value: string }>
}
const trashRules = require('../../cloudfunctions/cleanupTrash/rules') as {
  shouldPurgeTrash(item: Record<string, unknown>, now?: Date): boolean
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

  it('allows an optional free-text storage location', () => {
    expect(validation.validateSaveInput({ ...validSaveInput(), storageLocation: '  床头柜  ' })).toMatchObject({
      storageLocation: '床头柜',
    })
    expect(validation.validateSaveInput({ ...validSaveInput(), storageLocation: '冰箱' })).toMatchObject({
      storageLocation: '冰箱',
    })
    expect(validation.validateSaveInput({ ...validSaveInput(), storageLocation: '' })).toMatchObject({
      storageLocation: '',
    })
    expect(validation.validateSaveInput({
      ...validSaveInput(),
      storageLocation: undefined,
    })).toMatchObject({
      storageLocation: '',
    })
    expect(validation.validateSaveInput({
      ...validSaveInput(),
      storageLocation: `冰箱-${'很长的位置'.repeat(20)}`,
    })).toMatchObject({
      storageLocation: `冰箱-${'很长的位置'.repeat(20)}`,
    })
    expect(() => validation.validateSaveInput({
      ...validSaveInput(),
      storageLocation: 1,
    })).toThrow(/存放位置/)
  })

  it('validates decrement amounts and bounded batch references', () => {
    expect(validation.validateDecrementAmount(undefined)).toBe(1)
    expect(validation.validateDecrementAmount(3)).toBe(3)
    expect(() => validation.validateDecrementAmount(0)).toThrow(/整数/)
    expect(validation.validateBatchItems([{ itemId: 'a', version: 1 }])).toEqual([
      { itemId: 'a', version: 1 },
    ])
    expect(() => validation.validateBatchItems([
      { itemId: 'a', version: 1 },
      { itemId: 'a', version: 1 },
    ])).toThrow(/重复/)
  })

  it('escapes empty search semantics and limits search length', () => {
    expect(validation.validateSearch('  Milk  ')).toBe('milk')
    expect(() => validation.validateSearch('x'.repeat(41))).toThrow(/40/)
  })

  it('validates all inventory view statuses and defaults to active inventory', () => {
    for (const status of ['active_all', 'expired', 'expiring', 'safe', 'used_up']) {
      expect(validation.validateInventoryViewStatus(status)).toBe(status)
    }
    expect(validation.validateInventoryViewStatus(undefined)).toBe('active_all')
    expect(() => validation.validateInventoryViewStatus('discarded')).toThrow(/库存状态/)
  })

  it('keeps overview buckets mutually exclusive at -1, 0, 7 and 8 day boundaries', () => {
    const bucket = (status: string, expiryDate: string) =>
      inventoryRules.getOverviewBucket(status, expiryDate, '2026-09-07', '2026-09-14')
    expect(bucket('active', '2026-09-06')).toBe('expired')
    expect(bucket('active', '2026-09-07')).toBe('expiring')
    expect(bucket('active', '2026-09-14')).toBe('expiring')
    expect(bucket('active', '2026-09-15')).toBe('safe')
    expect(bucket('used_up', '2026-09-06')).toBe('used_up')
    expect(bucket('discarded', '2026-09-06')).toBeNull()
  })

  it('fills empty overview buckets and derives the active total', () => {
    expect(
      inventoryRules.summarizeOverviewRows([
        { _id: 'expired', total: 2 },
        { _id: 'safe', total: 5 },
        { _id: 'used_up', total: 3 },
      ]),
    ).toEqual({
      activeTotal: 7,
      expired: 2,
      expiringWithin7Days: 0,
      usedUpTotal: 3,
      safe: 5,
    })
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
    expect(inventoryRules.getDecrementDecision('active', 5, 4)).toBe('decrement')
    expect(inventoryRules.getDecrementDecision('active', 5, 5)).toBe('requires_completion')
    expect(inventoryRules.getDecrementDecision('active', 5, 6)).toBe('invalid_state')
    expect(inventoryRules.getDecrementDecision('discarded', 2)).toBe('invalid_state')
  })

  it('only lets active inventory enter a supported terminal state', () => {
    expect(inventoryRules.canTransitionInventory('active', 'used_up')).toBe(true)
    expect(inventoryRules.canTransitionInventory('active', 'discarded')).toBe(false)
    expect(inventoryRules.canTransitionInventory('used_up', 'discarded')).toBe(false)
    expect(inventoryRules.canTransitionInventory('active', 'deleted')).toBe(false)
  })

  it('lets both active and used-up items move to trash', () => {
    expect(inventoryRules.canMoveInventoryToTrash('active')).toBe(true)
    expect(inventoryRules.canMoveInventoryToTrash('used_up')).toBe(true)
    expect(inventoryRules.canMoveInventoryToTrash('deleted')).toBe(false)
    expect(inventoryRules.canMoveInventoryToTrash('discarded')).toBe(false)
  })
})

describe('trash retention', () => {
  const now = new Date('2026-09-07T12:00:00.000Z')

  it('only purges deleted records when their retention time has elapsed', () => {
    expect(trashRules.shouldPurgeTrash({
      inventoryStatus: 'deleted',
      purgeAfter: '2026-09-07T11:59:59.000Z',
    }, now)).toBe(true)
    expect(trashRules.shouldPurgeTrash({
      inventoryStatus: 'deleted',
      purgeAfter: '2026-09-07T12:00:01.000Z',
    }, now)).toBe(false)
    expect(trashRules.shouldPurgeTrash({
      inventoryStatus: 'used_up',
      purgeAfter: '2026-09-01T00:00:00.000Z',
    }, now)).toBe(false)
  })

  it('does not purge legacy discarded records before migration', () => {
    expect(trashRules.shouldPurgeTrash({
      inventoryStatus: 'discarded',
      completedAt: '2026-08-08T12:00:00.000Z',
    }, now)).toBe(false)
  })
})
