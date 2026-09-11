import { describe, expect, it } from 'vitest'

import {
  applyFormValuesToDraft,
  createDraftFromParsed,
  createDraftFromRecent,
  createSaveKey,
  draftToFormPrefill,
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
      parserVersion: 'rules-v3',
    })
  })

  it.each([
    ['瓜子一包，2周后过期，放客厅柜子', '2026-09-24'],
    ['瓜子一包，三周后过期，放客厅柜子', '2026-10-01'],
    ['瓜子一包，四天后过期，放客厅柜子', '2026-09-14'],
    ['瓜子一包，半个月后过期，放客厅柜子', '2026-09-25'],
    ['瓜子一包，半年后过期，放客厅柜子', '2027-03-10'],
    ['瓜子一包，有效期还有两周，放客厅柜子', '2026-09-24'],
    ['瓜子一包，过期时间是2周后，放客厅柜子', '2026-09-24'],
  ])('recognizes natural relative expiry in %s', (text, expiryDate) => {
    const [item] = parseQuickTextLocally(text, '2026-09-10').items

    expect(item).toMatchObject({
      name: '瓜子',
      quantity: 1,
      unit: '包',
      storageLocation: '客厅柜子',
    })
    expect(item.dateCandidates?.[0]).toMatchObject({ date: expiryDate, role: 'expiry', complete: true })
  })

  it.each([
    ['瓜子一包，下周三过期，放客厅柜子', '2026-09-16'],
    ['瓜子一包，这周三过期，放客厅柜子', '2026-09-09'],
    ['瓜子一包，上星期三过期，放客厅柜子', '2026-09-02'],
  ])('keeps weekday prefixes out of the item name in %s', (text, expiryDate) => {
    const [item] = parseQuickTextLocally(text, '2026-09-10').items

    expect(item.name).toBe('瓜子')
    expect(item.dateCandidates?.[0]).toMatchObject({ date: expiryDate, role: 'expiry' })
  })

  it.each([
    ['瓜子一包，生产日期2026-09-10，保质期半年', 6, 'month'],
    ['瓜子一包，生产日期2026-09-10，保质期半个月', 15, 'day'],
  ])('normalizes half-unit shelf life in %s', (text, shelfLifeValue, shelfLifeUnit) => {
    const [item] = parseQuickTextLocally(text, '2026-09-10').items

    expect(item).toMatchObject({ name: '瓜子', shelfLifeValue, shelfLifeUnit, expiryInputMode: 'shelf_life' })
  })

  it('keeps ambiguous local dates for explicit confirmation', () => {
    const [item] = parseQuickTextLocally('面包 1袋 9月20日', '2026-09-08').items

    expect(item.name).toBe('面包')
    expect(item.dateCandidates?.[0]).toMatchObject({ date: '2026-09-20', role: 'unknown' })
  })

  it('fills the shared entry form with the draft values as they are, conflicts included', () => {
    const draft = createDraftFromRecent(profile)
    draft.fields.expiryDate = '2026-09-20'
    draft.fields.productionDate = '2026-09-01'
    draft.dateConflict = '日期有冲突'

    expect(draftToFormPrefill(draft)).toEqual({
      name: '鲜牛奶',
      quantity: 2,
      unit: '盒',
      category: 'food',
      storageLocation: '冰箱',
      expiryInputMode: 'direct',
      expiryDate: '2026-09-20',
      productionDate: '2026-09-01',
      shelfLifeValue: null,
      shelfLifeUnit: null,
      reminderLeadDays: 0,
    })
  })

  it('only clears the confirmations the form actually resolved', () => {
    const draft = createDraftFromRecent({ ...profile, quantity: 0, invalidFields: ['quantity'] })
    draft.confirmationFields = ['quantity', 'date:0']
    expect(draft.status).toBe('needs_confirmation')

    // 点「完成」即视为逐项看过：非日期类待确认项结清
    const resolved = applyFormValuesToDraft(draft, draft.fields)
    expect(resolved.confirmationFields).toEqual(['date:0'])
    expect(resolved.status).toBe('needs_confirmation')

    // 日期真被改过之后，日期类歧义也一并结清
    const completed = applyFormValuesToDraft(draft, { ...draft.fields, expiryDate: '2026-09-25' })
    expect(completed.confirmationFields).toEqual([])
    expect(completed.status).toBe('savable')
  })

  it('carries only the active expiry mode into the draft', () => {
    const draft = createDraftFromParsed(parseQuickTextLocally('牛奶明天到期', '2026-09-08').items[0], 'text')
    const switched = applyFormValuesToDraft(draft, {
      ...draft.fields,
      expiryInputMode: 'shelf_life',
      expiryDate: null,
      productionDate: '2026-09-01',
      shelfLifeValue: 7,
      shelfLifeUnit: 'day',
    })
    expect(switched.fields.expiryDate).toBeNull()
    expect(switched.fields.productionDate).toBe('2026-09-01')
    expect(switched.fields.shelfLifeValue).toBe(7)
    expect(switched.status).toBe('savable')
  })

  it('drops the resolved AI hints once the user confirms the whole form', () => {
    const draft = createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1')
    draft.fields.expiryDate = '2026-09-20'
    expect(draft.aiMissingFields).toEqual(['quantity', 'unit'])

    const resolved = applyFormValuesToDraft(refreshDraftValidation(draft), { ...draft.fields })
    expect(resolved.aiMissingFields).toEqual([])
  })
})
