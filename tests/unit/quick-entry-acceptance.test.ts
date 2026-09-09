import { describe, expect, it } from 'vitest'
import { assignDateCandidate, createDraftFromParsed, createDraftFromRecent, draftToInventoryInput, draftToManualFields, getExpirySummary, parseQuickTextLocally, refreshDraftValidation } from '../../miniprogram/domain/quick-entry'
import { todayKey } from '../../miniprogram/domain/quick-text'
const cloudParser = require('../../cloudfunctions/quickEntryApi/quick-text')
const cloudDates = require('../../cloudfunctions/quickEntryApi/date-facts')
const { normalizeOcrLines } = require('../../cloudfunctions/quickEntryApi/tencent-provider')
const { validateMedia, mediaOwnerPrefix } = require('../../cloudfunctions/quickEntryApi/validation')
const { mergeRecentItems, readRecentProfiles } = require('../../cloudfunctions/inventoryApi/recent')
const today = '2026-09-08'
const draft = (text: string) => createDraftFromParsed(parseQuickTextLocally(text, today).items[0], 'text')

describe('quick entry product acceptance', () => {
  const sentences = [
    '鲜牛奶 2 盒，2026 年 9 月 12 日到期，放冰箱',
    '布洛芬 1 盒，生产日期 2026 年 9 月 1 日，保质期 2 年，放药箱',
    '牛奶 2 盒 9 月 12 日到期；酸奶 4 杯 9 月 15 日到期',
    '酸奶明年 3 月到期', '这盒牛奶能放 7 天', '酸奶还有 3 天到期',
    '面包 2026-09-01 2026-09-20', '酸奶 2026年2月30日到期',
    '牛奶两盒明天到期，分类食品', '牛奶2盒明天到期，酸奶4杯后天到期',
  ]
  it.each(sentences)('uses identical cloud and client rules for %s', text => {
    expect(parseQuickTextLocally(text, today)).toEqual(cloudParser.parseText(text, today))
  })
  it('uses Shanghai natural day even on a device outside China', () => {
    expect(todayKey(new Date('2026-09-07T16:01:00Z'))).toBe(today)
  })
  it('extracts every required production and shelf-life field', () => {
    const item = draft(sentences[1])
    expect(item.fields).toMatchObject({ name: '布洛芬', quantity: 1, unit: '盒', storageLocation: '药箱', productionDate: '2026-09-01', shelfLifeValue: 2, shelfLifeUnit: 'year' })
    expect(getExpirySummary(item)).toBe('2028-09-01')
    expect(draftToInventoryInput(item).input?.expiryDate).toBeNull()
  })
  it('supports clear pauses, connectors and five items without truncation', () => {
    expect(parseQuickTextLocally(sentences[2], today).items.map(item => item.name)).toEqual(['牛奶', '酸奶'])
    expect(parseQuickTextLocally(sentences[9], today).items).toHaveLength(2)
    expect(parseQuickTextLocally('牛奶2盒明天到期和酸奶4杯后天到期', today).items).toHaveLength(2)
    expect(() => parseQuickTextLocally(Array(6).fill('牛奶明天到期').join(';'), today)).toThrow('最多生成 5 条')
  })
  it('never invents a day or production date from incomplete phrases', () => {
    for (const text of ['酸奶明年3月到期', '酸奶2026年9月到期', '牛奶保质期7天', '这盒牛奶能放7天', '酸奶生产日期9月1日保质期7天']) {
      const item = draft(text)
      expect(item.fields.name).toMatch(/酸奶|牛奶/)
      expect(draftToInventoryInput(item).input).toBeNull()
    }
  })
  it('handles explicit relative dates and leap-day year completion', () => {
    expect(getExpirySummary(draft('牛奶还有3天到期'))).toBe('2026-09-11')
    expect(parseQuickTextLocally('牛奶2月29日到期', today).items[0].dateCandidates?.[0].date).toBe('2028-02-29')
  })
  it('requires confirmation for multiple unlabelled dates and strips uncertainty in manual fallback', () => {
    const item = draft('面包 2026-09-01 2026-09-20')
    expect(item.dateCandidates).toHaveLength(2)
    expect(draftToInventoryInput(item).input).toBeNull()
    expect(draftToManualFields(item).expiryDate).toBeUndefined()
    expect(draftToInventoryInput(assignDateCandidate(item, 1, 'expiry')).input?.expiryDate).toBe('2026-09-20')
  })
  it('detects conflicting labelled dates and displays both results', () => {
    const item = draft('面包 生产日期2026-09-01，保质期7天，到期日2026-09-20')
    expect(item.dateConflict).toContain('2026-09-08')
    expect(item.dateConflict).toContain('2026-09-20')
    expect(getExpirySummary(assignDateCandidate(item, 0, 'production'))).toBe('2026-09-08')
    expect(draftToInventoryInput(assignDateCandidate(item, 0, 'production')).input).not.toBeNull()
    expect(draftToInventoryInput(item).input).toBeNull()
    expect(draftToInventoryInput(assignDateCandidate(item, 1, 'expiry')).input?.expiryDate).toBe('2026-09-20')
  })
  it('does not allow candidate buttons to bypass expiry before production', () => {
    const item = draft('面包 生产日期2026-09-20，到期日2026-09-01')
    expect(item.dateInvalid).toBe(true)
    expect(draftToInventoryInput(assignDateCandidate(item, 1, 'expiry')).input).toBeNull()
    expect(draftToManualFields(item).expiryDate).toBeUndefined()
  })
  it('preserves OCR shelf life and keeps incomplete and low-confidence dates blocked', () => {
    const body = normalizeOcrLines([{ DetectedText: 'MFG 2026-09-01 保质期2年', Confidence: 99 }], today)
    const result = cloudDates.normalizePhotoResult(body, today)
    const item = createDraftFromParsed({ ...result, dateCandidates: result.candidates }, 'date_photo')
    expect(item.fields.shelfLifeValue).toBe(2)
    expect(item.fields.productionDate).toBe('2026-09-01')
    expect(item.fields.name).toBe('')
    expect(draftToInventoryInput(item).input).toBeNull()
    expect(normalizeOcrLines([{ DetectedText: 'EXP 2026-09-20', Confidence: 30 }], today).candidates[0].complete).toBe(false)
    expect(cloudDates.normalizePhotoResult({ dateFacts: [{ kind: 'expiry', month: 9, day: 20 }] }, today).candidates[0].date).toBeNull()
  })
  it('uses recent non-date fields but never copies old batch dates', () => {
    const recent = { name: '牛奶', quantity: 0, unit: '盒', category: 'food' as const, storageLocation: '冰箱', reminderLeadDays: 0, expiryInputMode: 'shelf_life' as const, shelfLifeValue: 7, shelfLifeUnit: 'day' as const }
    const reused = createDraftFromRecent(recent)
    expect(reused.fields).toMatchObject({ productionDate: null, expiryDate: null, shelfLifeValue: 7 })
    const parsed = createDraftFromParsed(parseQuickTextLocally('牛奶明天到期', today).items[0], 'text', 3, recent)
    expect(parsed.fields).toMatchObject({ quantity: 1, unit: '盒', reminderLeadDays: 0 })
    expect(parsed.confirmationFields).toContain('quantity')
  })
  it('deduplicates exact normalized names without merging meaningful spaces', () => {
    const rows = [' 鲜牛奶 ', '鲜牛奶', 'C-100', 'c-100', '牛奶 250ml', '牛奶250ml'].map((name, i) => ({ name, updatedAt: new Date(2026, 0, i + 1) }))
    expect(mergeRecentItems(rows).map((item: { name: string }) => item.name)).toEqual(['牛奶250ml', '牛奶 250ml', 'c-100', '鲜牛奶'])
  })
  it('reads beyond duplicate pages before accepting older profiles from another status', async () => {
    const active = [...Array.from({ length: 30 }, (_, i) => ({ name: '牛奶', updatedAt: new Date(2026, 8, 30, 0, 0, -i) })), { name: '新面包', updatedAt: new Date(2026, 8, 29) }]
    const used = Array.from({ length: 6 }, (_, i) => ({ name: `旧物品${i}`, updatedAt: new Date(2020, 0, 6 - i) }))
    const result = await readRecentProfiles(async (status: string, offset: number, limit: number) => (status === 'active' ? active : used).slice(offset, offset + limit))
    expect(result.items.map((item: { name: string }) => item.name)).toEqual([
      '牛奶', '新面包', '旧物品0', '旧物品1', '旧物品2', '旧物品3', '旧物品4', '旧物品5',
    ])
  })
  it('caps the recent list at the configured limit', () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({ name: `物品${i}`, updatedAt: new Date(2026, 0, 1, 0, 0, 130 - i) }))
    expect(mergeRecentItems(rows)).toHaveLength(100)
    expect(mergeRecentItems(rows, 3).map((item: { name: string }) => item.name)).toEqual(['物品0', '物品1', '物品2'])
  })
  it('rejects out-of-range calculated expiry before enabling save', () => {
    const item = draft('面包生产日期2200-12-31，保质期1年')
    expect(refreshDraftValidation(item).issues.some(issue => issue.field === 'shelfLifeValue')).toBe(true)
  })
  it('isolates media ownership before downloading or deleting', () => {
    const fileID = `cloud://env.bucket/${mediaOwnerPrefix('alice')}image/example.jpg`
    expect(validateMedia({ fileID, mediaType: 'image' }, 'image', 'alice')).toBe(fileID)
    expect(() => validateMedia({ fileID, mediaType: 'image' }, 'image', 'bob')).toThrow('不属于当前用户')
  })
  it('does not turn unrelated conversations into inventory names', () => {
    expect(() => parseQuickTextLocally('请问今天天气怎么样', today)).toThrow('没有识别出物品和日期')
  })
})
