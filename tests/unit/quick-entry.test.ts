import { describe, expect, it } from 'vitest'

import {
  createDraftFromRecent,
  createSaveKey,
  parseQuickTextLocally,
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

  it('parses a common sentence locally when the recognition service is unavailable', () => {
    const result = parseQuickTextLocally('鲜牛奶 2盒，9月12日到期，放冰箱', '2026-09-08')

    expect(result).toEqual({
      items: [{
        name: '鲜牛奶',
        quantity: 2,
        unit: '盒',
        storageLocation: '冰箱',
        expiryInputMode: undefined,
        shelfLifeValue: undefined,
        shelfLifeUnit: undefined,
        dateCandidates: [{
          date: '2026-09-12',
          role: 'expiry',
          rawText: '9月12日',
          complete: true,
          source: 'text',
        }],
      }],
      serverToday: '2026-09-08',
      parserVersion: 'rules-v2',
    })
  })

  it('keeps ambiguous local dates for explicit confirmation', () => {
    const [item] = parseQuickTextLocally('面包 1袋 9月20日', '2026-09-08').items

    expect(item.name).toBe('面包')
    expect(item.dateCandidates?.[0]).toMatchObject({ date: '2026-09-20', role: 'unknown' })
  })
})
