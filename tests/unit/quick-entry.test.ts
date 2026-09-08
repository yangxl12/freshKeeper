import { describe, expect, it } from 'vitest'

import {
  createDraftFromRecent,
  createSaveKey,
  refreshDraftValidation,
} from '../../miniprogram/domain/quick-entry'
import type { RecentItemProfile } from '../../miniprogram/types/quick-entry'

const profile: RecentItemProfile = {
  name: '鲜牛奶',
  quantity: 2,
  unit: '盒',
  category: 'food',
  storageLocation: '冰箱',
  reminderLeadDays: 0,
  expiryInputMode: 'direct',
  shelfLifeValue: null,
  shelfLifeUnit: null,
}

describe('quick entry drafts', () => {
  it('creates backend-compatible UUID v4 save keys', () => {
    expect(createSaveKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('clears old dates and selects a recent draft after the missing date is filled', () => {
    const draft = createDraftFromRecent(profile)
    expect(draft.fields.expiryDate).toBeNull()
    expect(draft.selected).toBe(false)
    const completed = refreshDraftValidation({
      ...draft,
      fields: { ...draft.fields, expiryDate: '2026-09-20' },
    })
    expect(completed.status).toBe('savable')
    expect(completed.selected).toBe(true)
    expect(completed.fields.reminderLeadDays).toBe(0)
  })

  it('falls back invalid legacy fields and requires confirmation', () => {
    const draft = createDraftFromRecent({ ...profile, quantity: 0, unit: '', invalidFields: ['quantity', 'unit'] })
    expect(draft.fields.quantity).toBe(1)
    expect(draft.fields.unit).toBe('件')
    expect(draft.status).toBe('needs_confirmation')
  })
})
