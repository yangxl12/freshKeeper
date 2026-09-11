import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from './inventory'
import type { Category, InventorySaveInput } from '../types/inventory'
import type {
  QuickEntryDraft,
  QuickEntryDraftFields,
  QuickEntryDraftIssue,
  QuickEntryParseResult,
  QuickEntrySource,
  RecentItemProfile,
} from '../types/quick-entry'
import { asInventorySaveInput } from '../types/quick-entry'
import {
  calculateExpiryDate,
  parseDateKey,
} from '../utils/date-key'

export { parseText as parseQuickTextLocally } from './quick-text'

export function normalizeRecentName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z]/g, (letter) => letter.toLowerCase())
}

export function createSaveKey(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16)
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

export function defaultQuickEntryFields(reminderLeadDays = 1): QuickEntryDraftFields {
  return {
    name: '',
    quantity: 1,
    unit: '件',
    category: 'food',
    storageLocation: '',
    expiryInputMode: 'direct',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: 'day',
    expiryDate: null,
    reminderLeadDays,
  }
}

function issue(code: QuickEntryDraftIssue['code'], field: string, message: string) {
  return { code, field, message }
}

function isValidCategory(value: unknown): value is Category {
  return CATEGORY_OPTIONS.some((option) => option.value === value && value !== '')
}

function confirmationIssue(field: string): QuickEntryDraftIssue {
  if (field === 'quantity') return issue('INVALID_FIELD', field, '原记录数量无效，已改为 1，请确认')
  if (field === 'unit') return issue('INVALID_FIELD', field, '原记录单位无效，已改为“件”，请确认')
  if (field === 'category') return issue('INVALID_FIELD', field, '原记录分类无效，已改为“食品”，请确认')
  if (field === 'reminderLeadDays') return issue('INVALID_FIELD', field, '原记录提醒设置无效，已使用当前默认值，请确认')
  if (field === 'shelfLifeUnit') return issue('INVALID_FIELD', field, '原记录保质期单位无效，已改为“天”，请确认')
  if (field.startsWith('date:')) return issue('AMBIGUOUS_DATE', field, '请选择识别日期的含义')
  return issue('INVALID_FIELD', field, '请确认修正后的字段')
}

export function validateQuickEntryFields(fields: QuickEntryDraftFields): QuickEntryDraftIssue[] {
  const issues: QuickEntryDraftIssue[] = []
  if (!fields.name.trim() || fields.name.trim().length > 40) {
    issues.push(issue('MISSING_NAME', 'name', '请填写 1～40 个字符的物品名称'))
  }
  if (!Number.isInteger(fields.quantity) || (fields.quantity as number) < 1 || (fields.quantity as number) > 9999) {
    issues.push(issue('INVALID_FIELD', 'quantity', '数量需为 1～9999 的整数'))
  }
  if (!fields.unit.trim() || fields.unit.trim().length > 8) {
    issues.push(issue('INVALID_FIELD', 'unit', '请填写 1～8 个字符的单位'))
  }
  if (!fields.category || !CATEGORY_OPTIONS.some((option) => option.value === fields.category)) {
    issues.push(issue('INVALID_FIELD', 'category', '请选择物品分类'))
  }
  if (!Number.isInteger(fields.reminderLeadDays) || (fields.reminderLeadDays as number) < 0 || (fields.reminderLeadDays as number) > 30) {
    issues.push(issue('INVALID_FIELD', 'reminderLeadDays', '提醒天数需为 0～30 的整数'))
  }
  if (fields.expiryInputMode === 'direct') {
    if (!parseDateKey(fields.expiryDate || '')) issues.push(issue('MISSING_EXPIRY', 'expiryDate', '请选择到期日期'))
  } else {
    if (!parseDateKey(fields.productionDate || '')) issues.push(issue('MISSING_EXPIRY', 'productionDate', '请选择生产日期'))
    if (!Number.isInteger(fields.shelfLifeValue) || (fields.shelfLifeValue as number) <= 0) {
      issues.push(issue('INVALID_FIELD', 'shelfLifeValue', '请填写有效的保质期'))
    }
    if (!SHELF_LIFE_OPTIONS.some((option) => option.value === fields.shelfLifeUnit)) {
      issues.push(issue('INVALID_FIELD', 'shelfLifeUnit', '请选择保质期单位'))
    }
    if (!issues.some((item) => ['productionDate', 'shelfLifeValue', 'shelfLifeUnit'].includes(item.field || ''))) {
      try {
        calculateExpiryDate({ mode: 'shelf_life', ...fields })
      } catch (_error) {
        issues.push(issue('INVALID_FIELD', 'shelfLifeValue', '计算结果超出有效日期范围，请修改保质期'))
      }
    }
  }
  return issues
}

export interface RecentSourceItem {
  name?: string
  quantity?: number | null
  unit?: string
  category?: string | null
  storageLocation?: string
  reminderLeadDays?: number | null
  expiryInputMode?: string
  shelfLifeValue?: number | null
  shelfLifeUnit?: string | null
  updatedAt?: string | Date
  createdAt?: string | Date
}

const VALID_SHELF_LIFE_UNITS = new Set(['day', 'month', 'year'])

function recentTimestamp(value: string | Date | undefined): number {
  if (!value) return 0
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(result) ? result : 0
}

/** 与云端 recent.js 的 toRecentProfile 规则保持一致，供云函数未更新时本地兜底。 */
export function toRecentProfile(item: RecentSourceItem): RecentItemProfile {
  const invalidFields: string[] = []
  const quantity = Number.isInteger(item.quantity) && (item.quantity as number) >= 1 && (item.quantity as number) <= 9999
    ? item.quantity as number
    : 1
  if (quantity !== item.quantity) invalidFields.push('quantity')
  const unit = typeof item.unit === 'string' && item.unit.trim().length >= 1 && item.unit.trim().length <= 8
    ? item.unit.trim()
    : '件'
  if (unit !== item.unit) invalidFields.push('unit')
  const category = isValidCategory(item.category) ? item.category : 'food'
  if (category !== item.category) invalidFields.push('category')
  const reminderLeadDays = Number.isInteger(item.reminderLeadDays) && (item.reminderLeadDays as number) >= 0 && (item.reminderLeadDays as number) <= 30
    ? item.reminderLeadDays as number
    : 1
  if (reminderLeadDays !== item.reminderLeadDays) invalidFields.push('reminderLeadDays')
  const expiryInputMode: QuickEntryDraftFields['expiryInputMode'] = item.expiryInputMode === 'shelf_life' ? 'shelf_life' : 'direct'
  const shelfLifeUnit = expiryInputMode === 'shelf_life' && item.shelfLifeUnit && VALID_SHELF_LIFE_UNITS.has(item.shelfLifeUnit)
    ? item.shelfLifeUnit as QuickEntryDraftFields['shelfLifeUnit']
    : null
  if (expiryInputMode === 'shelf_life' && shelfLifeUnit !== item.shelfLifeUnit) invalidFields.push('shelfLifeUnit')
  return {
    name: typeof item.name === 'string' ? item.name : '',
    quantity,
    unit,
    category,
    storageLocation: typeof item.storageLocation === 'string' ? item.storageLocation : '',
    reminderLeadDays,
    expiryInputMode,
    shelfLifeValue: expiryInputMode === 'shelf_life' && Number.isInteger(item.shelfLifeValue) ? item.shelfLifeValue as number : null,
    shelfLifeUnit,
    invalidFields,
  }
}

export function recentProfilesFromItems(items: RecentSourceItem[], limit = 6): RecentItemProfile[] {
  const sorted = [...items].sort((left, right) => (
    recentTimestamp(right.updatedAt || right.createdAt) - recentTimestamp(left.updatedAt || left.createdAt)
  ))
  const seen = new Set<string>()
  const result: RecentItemProfile[] = []
  for (const item of sorted) {
    const key = normalizeRecentName(item.name || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(toRecentProfile(item))
    if (result.length >= limit) break
  }
  return result
}

export function createDraftFromRecent(profile: RecentItemProfile, reminderLeadDays = 1): QuickEntryDraft {
  const confirmationFields: string[] = []
  const quantityValid = Number.isInteger(profile.quantity) && profile.quantity >= 1 && profile.quantity <= 9999
  const quantity = quantityValid ? profile.quantity : 1
  if (!quantityValid) confirmationFields.push('quantity')
  const unitValid = typeof profile.unit === 'string' && profile.unit.trim().length >= 1 && profile.unit.trim().length <= 8
  if (!unitValid) confirmationFields.push('unit')
  const categoryValid = isValidCategory(profile.category)
  if (!categoryValid) confirmationFields.push('category')
  const reminderValid = Number.isInteger(profile.reminderLeadDays) && profile.reminderLeadDays >= 0 && profile.reminderLeadDays <= 30
  if (!reminderValid) confirmationFields.push('reminderLeadDays')
  const category = categoryValid ? profile.category : 'food'
  const expiryInputMode = profile.expiryInputMode === 'shelf_life' ? 'shelf_life' : 'direct'
  const shelfLifeUnitValid = profile.shelfLifeUnit === 'day' || profile.shelfLifeUnit === 'month' || profile.shelfLifeUnit === 'year'
  if (expiryInputMode === 'shelf_life' && !shelfLifeUnitValid) confirmationFields.push('shelfLifeUnit')
  for (const field of profile.invalidFields || []) {
    if (!confirmationFields.includes(field)) confirmationFields.push(field)
  }
  const fields: QuickEntryDraftFields = {
    ...defaultQuickEntryFields(reminderLeadDays),
    name: typeof profile.name === 'string' ? profile.name : '',
    quantity,
    unit: unitValid ? profile.unit.trim() : '件',
    category,
    storageLocation: profile.storageLocation || '',
    expiryInputMode,
    shelfLifeValue: expiryInputMode === 'shelf_life' ? profile.shelfLifeValue : null,
    shelfLifeUnit: expiryInputMode === 'shelf_life' ? (shelfLifeUnitValid ? profile.shelfLifeUnit : 'day') : null,
    productionDate: null,
    expiryDate: null,
    reminderLeadDays: reminderValid ? profile.reminderLeadDays : reminderLeadDays,
  }
  return refreshDraftValidation({
    draftId: createSaveKey(),
    saveKey: createSaveKey(),
    source: 'recent',
    status: 'needs_input',
    fields,
    issues: [],
    selected: false,
    dateCandidates: [],
    confirmationFields,
  })
}

export function refreshDraftValidation(draft: QuickEntryDraft): QuickEntryDraft {
  const issues = validateQuickEntryFields(draft.fields)
  if (draft.dateConflict) issues.push(issue('DATE_CONFLICT', 'expiryDate', draft.dateConflict))
  if (draft.dateInvalid) issues.push(issue('DATE_CONFLICT', 'expiryDate', '到期日期早于生产日期，请手动修正或重拍'))
  const confirmationFields = draft.confirmationFields || []
  issues.push(...confirmationFields.map(confirmationIssue))
  const wasBlocked = draft.issues.length > 0 || confirmationFields.length > 0
  return {
    ...draft,
    issues,
    status: draft.status === 'saved' || draft.status === 'saving'
      ? draft.status
      : confirmationFields.length
        ? 'needs_confirmation'
        : issues.length
          ? 'needs_input'
          : 'savable',
    selected: issues.length ? false : (wasBlocked ? true : draft.selected),
    errorMessage: undefined,
  }
}

export function createDraftFromParsed(
  item: QuickEntryParseResult['items'][number],
  source: Extract<QuickEntrySource, 'text' | 'voice' | 'date_photo'>,
  reminderLeadDays = 1,
  recentProfile?: RecentItemProfile,
  evidence?: QuickEntryDraft['evidence'],
  parserVersion?: string,
): QuickEntryDraft {
  const recentDraft = recentProfile ? createDraftFromRecent(recentProfile, reminderLeadDays) : undefined
  const recent = recentDraft?.fields
  const fields = defaultQuickEntryFields(reminderLeadDays)
  fields.name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : recent?.name || ''
  fields.quantity = Number.isInteger(item.quantity) ? item.quantity as number : recent?.quantity || 1
  fields.unit = typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : recent?.unit || '件'
  fields.category = isValidCategory(item.category) ? item.category : (isValidCategory(recent?.category) ? recent.category : 'food')
  fields.storageLocation = typeof item.storageLocation === 'string' ? item.storageLocation.trim() : recent?.storageLocation || ''
  fields.reminderLeadDays = recent && recent.reminderLeadDays != null && Number.isInteger(recent.reminderLeadDays) && recent.reminderLeadDays >= 0 && recent.reminderLeadDays <= 30
    ? recent.reminderLeadDays
    : reminderLeadDays
  fields.expiryInputMode = item.expiryInputMode === 'shelf_life' || item.shelfLifeValue ? 'shelf_life' : 'direct'
  fields.shelfLifeValue = Number.isInteger(item.shelfLifeValue) ? item.shelfLifeValue as number : null
  fields.shelfLifeUnit = item.shelfLifeUnit || (fields.expiryInputMode === 'shelf_life' ? 'day' : null)

  // AI 只在原文里找得到证据时才返回字段，没找到就是 null。这里把「它没说」和「它说错了」区分开：
  // 不写进 confirmationFields（那会挡住本来就合法的草稿），只提示用户核对默认填充值。
  const aiMissingFields = source !== 'date_photo' && parserVersion?.startsWith('ai-') && !recent
    ? [
      ...(item.quantity == null ? ['quantity'] : []),
      ...(!item.unit ? ['unit'] : []),
    ]
    : []

  const candidates = Array.isArray(item.dateCandidates) ? item.dateCandidates : []
  const completeCandidates = candidates.filter((candidate) => candidate.complete && parseDateKey(candidate.date || ''))
  const expiryCandidates = completeCandidates.filter((candidate) => candidate.role === 'expiry')
  const productionCandidates = completeCandidates.filter((candidate) => candidate.role === 'production')
  const confirmationFields: string[] = (recentDraft?.confirmationFields || []).filter(field => item[field as keyof typeof item] == null)
  let dateConflict: string | undefined
  let dateInvalid = false

  if (expiryCandidates.length === 1) {
    const expiryDate = expiryCandidates[0].date as string
    fields.expiryInputMode = 'direct'
    fields.expiryDate = expiryDate
    fields.productionDate = productionCandidates.length === 1 ? productionCandidates[0].date : null
    if (productionCandidates.length === 1 && productionCandidates[0].date && expiryDate < productionCandidates[0].date) {
      confirmationFields.push(`date:${candidates.indexOf(expiryCandidates[0])}`)
      confirmationFields.push(`date:${candidates.indexOf(productionCandidates[0])}`)
      dateInvalid = true
    } else if (productionCandidates.length === 1 && fields.shelfLifeValue && fields.shelfLifeUnit) {
      try {
        const calculated = calculateExpiryDate({
          mode: 'shelf_life',
          productionDate: productionCandidates[0].date as string,
          shelfLifeValue: fields.shelfLifeValue,
          shelfLifeUnit: fields.shelfLifeUnit,
        })
        if (calculated !== fields.expiryDate) {
          dateConflict = `日期有冲突：标注到期 ${fields.expiryDate}，按保质期计算 ${calculated}，请选择或手动修正`
          confirmationFields.push(`date:${candidates.indexOf(expiryCandidates[0])}`)
          confirmationFields.push(`date:${candidates.indexOf(productionCandidates[0])}`)
        }
      } catch (_error) {
        confirmationFields.push(`date:${candidates.indexOf(productionCandidates[0])}`)
      }
    }
  } else if (expiryCandidates.length > 1) {
    expiryCandidates.forEach((candidate) => confirmationFields.push(`date:${candidates.indexOf(candidate)}`))
  } else if (productionCandidates.length === 1) {
    fields.expiryInputMode = 'shelf_life'
    fields.productionDate = productionCandidates[0].date
  } else if (productionCandidates.length > 1) {
    productionCandidates.forEach((candidate) => confirmationFields.push(`date:${candidates.indexOf(candidate)}`))
  }
  completeCandidates
    .filter((candidate) => candidate.role === 'unknown')
    .forEach((candidate) => confirmationFields.push(`date:${candidates.indexOf(candidate)}`))

  return refreshDraftValidation({
    draftId: createSaveKey(),
    saveKey: createSaveKey(),
    source,
    status: 'needs_input',
    fields,
    issues: [],
    selected: true,
    dateCandidates: candidates,
    confirmationFields,
    dateConflict,
    dateInvalid,
    evidence,
    parserVersion,
    aiMissingFields,
  })
}

export function assignDateCandidate(
  draft: QuickEntryDraft,
  candidateIndex: number,
  role: 'expiry' | 'production',
): QuickEntryDraft {
  const candidate = draft.dateCandidates[candidateIndex]
  if (!candidate || !candidate.complete || !parseDateKey(candidate.date || '')) return draft
  if (draft.dateInvalid) return draft
  const confirmationFields = (draft.confirmationFields || []).filter((field) => (
    role === 'expiry' || draft.dateConflict ? !field.startsWith('date:') : field !== `date:${candidateIndex}`
  ))
  return refreshDraftValidation({
    ...draft,
    confirmationFields,
    dateConflict: undefined,
    dateCandidates: draft.dateCandidates.map((item, index) => index === candidateIndex ? { ...item, role } : item),
    fields: role === 'expiry'
      ? { ...draft.fields, expiryInputMode: 'direct', expiryDate: candidate.date, productionDate: null }
      : { ...draft.fields, expiryInputMode: 'shelf_life', productionDate: candidate.date, expiryDate: null },
  })
}

export function getDraftSummary(draft: QuickEntryDraft): string {
  const fields = draft.fields
  const quantity = fields.quantity == null ? '待补数量' : `${fields.quantity}${fields.unit || '件'}`
  const location = fields.storageLocation ? ` · ${fields.storageLocation}` : ''
  return `${quantity} · ${categoryLabel(fields.category)}${location} · 提前${fields.reminderLeadDays ?? 1}天提醒`
}

export function getExpirySummary(draft: QuickEntryDraft): string {
  if (draft.fields.expiryInputMode === 'direct') return draft.fields.expiryDate || '待补到期日'
  if (draft.fields.productionDate && draft.fields.shelfLifeValue && draft.fields.shelfLifeUnit) {
    try {
      return calculateExpiryDate({
        mode: 'shelf_life',
        productionDate: draft.fields.productionDate,
        shelfLifeValue: draft.fields.shelfLifeValue,
        shelfLifeUnit: draft.fields.shelfLifeUnit,
      })
    } catch (_error) {
      return '待补到期信息'
    }
  }
  return '待补到期信息'
}

export function draftToInventoryInput(draft: QuickEntryDraft) {
  const issues = refreshDraftValidation(draft).issues
  if (issues.length) return { input: null, issues }
  return { input: asInventorySaveInput(draft.fields), issues: [] }
}

export function draftToManualFields(draft: QuickEntryDraft): Partial<import('../types/inventory').InventorySaveInput> {
  const blocked = new Set(refreshDraftValidation(draft).issues.map(item => item.field))
  const fields = { ...draft.fields }
  if (draft.dateConflict || draft.dateInvalid || draft.confirmationFields?.some(field => field.startsWith('date:'))) {
    fields.expiryDate = null
    fields.productionDate = null
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) if (!blocked.has(key)) result[key] = value
  return result
}

/**
 * 把草稿灌进共用的完整录入表单。
 * 与 draftToManualFields 的区别：这里如实带上当前值（含冲突日期），不做「有问题就清空」的裁剪——
 * 用户是进来看清楚再改的，把有疑问的日期藏起来只会让人无从下手。
 */
export function draftToFormPrefill(draft: QuickEntryDraft): Partial<InventorySaveInput> {
  const fields = draft.fields
  return {
    name: fields.name,
    quantity: fields.quantity ?? undefined,
    unit: fields.unit,
    category: fields.category ?? undefined,
    storageLocation: fields.storageLocation,
    expiryInputMode: fields.expiryInputMode,
    expiryDate: fields.expiryDate,
    productionDate: fields.productionDate,
    shelfLifeValue: fields.shelfLifeValue,
    shelfLifeUnit: fields.shelfLifeUnit,
    reminderLeadDays: fields.reminderLeadDays ?? undefined,
  }
}

/**
 * 完整录入表单点「完成」后回写草稿。
 * 用户逐项看过整张表单再点完成，所以数量/单位/分类这类待确认项就此结清；
 * 日期类待确认项只在日期真的被改过时才结清——否则「没改就点完成」会静默吃掉日期冲突提示。
 */
export function applyFormValuesToDraft(draft: QuickEntryDraft, fields: QuickEntryDraftFields): QuickEntryDraft {
  const before = draft.fields
  const dateTouched =
    fields.expiryInputMode !== before.expiryInputMode ||
    fields.expiryDate !== before.expiryDate ||
    fields.productionDate !== before.productionDate ||
    fields.shelfLifeValue !== before.shelfLifeValue ||
    fields.shelfLifeUnit !== before.shelfLifeUnit
  const confirmationFields = (draft.confirmationFields || [])
    .filter(field => field.startsWith('date:') && !dateTouched)
  return refreshDraftValidation({
    ...draft,
    fields,
    confirmationFields,
    dateConflict: dateTouched ? undefined : draft.dateConflict,
    dateInvalid: dateTouched ? false : draft.dateInvalid,
    aiMissingFields: [],
  })
}

export function categoryLabel(category: Category | null): string {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label || '未分类'
}
