import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from './inventory'
import type { Category } from '../types/inventory'
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
  addDays,
  calculateExpiryDate,
  daysInMonth,
  formatDateKey,
  localTodayKey,
  parseDateKey,
} from '../utils/date-key'

const LOCAL_ENTRY_SEPARATOR = /[\n；;]+/
const LOCAL_QUANTITY_PATTERN = /(\d{1,4})\s*(盒|瓶|袋|包|罐|个|件|支|箱|片|粒|份|桶|公斤|千克|克|斤|毫升|升)/
const LOCAL_SHELF_LIFE_PATTERN = /保质期\s*(\d{1,4})\s*(天|日|个月|月|年)/
const LOCAL_STORAGE_PATTERN = /(?:放|存放)(?:在|到)?\s*([^\s，,；;]{1,20})/
const LOCAL_FULL_DATE_PATTERN = /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?/
const LOCAL_MONTH_DAY_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/
const LOCAL_RELATIVE_DATE_PATTERN = /(今天|明天|后天|(\d{1,4})\s*天后)/

function localDateKey(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return formatDateKey({ year, month, day })
}

function nearestLocalMonthDay(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4))
  const currentYear = localDateKey(year, month, day)
  if (currentYear && currentYear >= today) return currentYear
  return localDateKey(year + 1, month, day)
}

function localDateRole(text: string, index: number, rawText: string): 'expiry' | 'production' | 'unknown' {
  const context = text.slice(Math.max(0, index - 8), index + rawText.length + 8)
  if (/(生产|出厂|制造)/.test(context)) return 'production'
  if (/(到期|过期|有效期|失效|EXP)/i.test(context)) return 'expiry'
  return 'unknown'
}

function localDateCandidate(text: string, today: string) {
  const full = LOCAL_FULL_DATE_PATTERN.exec(text)
  if (full) {
    const date = localDateKey(Number(full[1]), Number(full[2]), Number(full[3]))
    return { date, role: localDateRole(text, full.index, full[0]), rawText: full[0], complete: Boolean(date), source: 'text' as const }
  }
  const monthDay = LOCAL_MONTH_DAY_PATTERN.exec(text)
  if (monthDay) {
    const date = nearestLocalMonthDay(today, Number(monthDay[1]), Number(monthDay[2]))
    return { date, role: localDateRole(text, monthDay.index, monthDay[0]), rawText: monthDay[0], complete: Boolean(date), source: 'text' as const }
  }
  const relative = LOCAL_RELATIVE_DATE_PATTERN.exec(text)
  if (relative) {
    const offset = relative[1] === '今天' ? 0 : relative[1] === '明天' ? 1 : relative[1] === '后天' ? 2 : Number(relative[2])
    const date = Number.isInteger(offset) && offset <= 3650 ? addDays(today, offset) : null
    return { date, role: localDateRole(text, relative.index, relative[0]) === 'production' ? 'production' as const : 'expiry' as const, rawText: relative[0], complete: Boolean(date), source: 'text' as const }
  }
  return null
}

function localShelfLifeUnit(value: string) {
  if (value === '年') return 'year' as const
  if (value === '月' || value === '个月') return 'month' as const
  return 'day' as const
}

function localItemName(text: string): string {
  return text
    .replace(LOCAL_FULL_DATE_PATTERN, ' ')
    .replace(LOCAL_MONTH_DAY_PATTERN, ' ')
    .replace(LOCAL_RELATIVE_DATE_PATTERN, ' ')
    .replace(LOCAL_SHELF_LIFE_PATTERN, ' ')
    .replace(LOCAL_QUANTITY_PATTERN, ' ')
    .replace(LOCAL_STORAGE_PATTERN, ' ')
    .replace(/(?:到期|过期|有效期至?|失效|生产日期?|出厂日期?|制造日期?)/gi, ' ')
    .replace(/^(?:新增|添加|录入|买了?)\s*/, '')
    .replace(/[，,。.!！?？、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseQuickTextLocally(text: string, today = localTodayKey()): QuickEntryParseResult {
  const normalized = text.trim()
  if (!normalized) throw new Error('请输入要识别的内容')
  if (normalized.length > 500) throw new Error('一次最多识别 500 个字符')
  const entries = normalized.split(LOCAL_ENTRY_SEPARATOR).map((entry) => entry.trim()).filter(Boolean)
  if (entries.length > 5) throw new Error('一次最多生成 5 条草稿，请分次录入')
  return {
    items: entries.map((entry) => {
      const quantity = LOCAL_QUANTITY_PATTERN.exec(entry)
      const shelfLife = LOCAL_SHELF_LIFE_PATTERN.exec(entry)
      const storage = LOCAL_STORAGE_PATTERN.exec(entry)
      const candidate = localDateCandidate(entry, today)
      return {
        name: localItemName(entry),
        quantity: quantity ? Number(quantity[1]) : undefined,
        unit: quantity?.[2],
        storageLocation: storage?.[1],
        expiryInputMode: shelfLife ? 'shelf_life' as const : undefined,
        shelfLifeValue: shelfLife ? Number(shelfLife[1]) : undefined,
        shelfLifeUnit: shelfLife ? localShelfLifeUnit(shelfLife[2]) : undefined,
        dateCandidates: candidate ? [candidate] : [],
      }
    }),
    serverToday: today,
    parserVersion: 'local-v1',
  }
}

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
  }
  return issues
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
): QuickEntryDraft {
  const recent = recentProfile
  const fields = defaultQuickEntryFields(reminderLeadDays)
  fields.name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : recent?.name || ''
  fields.quantity = Number.isInteger(item.quantity) ? item.quantity as number : recent?.quantity || 1
  fields.unit = typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : recent?.unit || '件'
  fields.category = isValidCategory(item.category) ? item.category : (isValidCategory(recent?.category) ? recent.category : 'food')
  fields.storageLocation = typeof item.storageLocation === 'string' ? item.storageLocation.trim() : recent?.storageLocation || ''
  fields.reminderLeadDays = recent && Number.isInteger(recent.reminderLeadDays) && recent.reminderLeadDays >= 0 && recent.reminderLeadDays <= 30
    ? recent.reminderLeadDays
    : reminderLeadDays
  fields.expiryInputMode = item.expiryInputMode === 'shelf_life' || item.shelfLifeValue ? 'shelf_life' : 'direct'
  fields.shelfLifeValue = Number.isInteger(item.shelfLifeValue) ? item.shelfLifeValue as number : null
  fields.shelfLifeUnit = item.shelfLifeUnit || (fields.expiryInputMode === 'shelf_life' ? 'day' : null)

  const candidates = Array.isArray(item.dateCandidates) ? item.dateCandidates : []
  const completeCandidates = candidates.filter((candidate) => candidate.complete && parseDateKey(candidate.date || ''))
  const expiryCandidates = completeCandidates.filter((candidate) => candidate.role === 'expiry')
  const productionCandidates = completeCandidates.filter((candidate) => candidate.role === 'production')
  const confirmationFields: string[] = []

  if (expiryCandidates.length === 1) {
    const expiryDate = expiryCandidates[0].date as string
    fields.expiryInputMode = 'direct'
    fields.expiryDate = expiryDate
    if (productionCandidates.length === 1 && productionCandidates[0].date && expiryDate < productionCandidates[0].date) {
      confirmationFields.push(`date:${candidates.indexOf(expiryCandidates[0])}`)
      confirmationFields.push(`date:${candidates.indexOf(productionCandidates[0])}`)
    } else if (productionCandidates.length === 1 && fields.shelfLifeValue && fields.shelfLifeUnit) {
      try {
        const calculated = calculateExpiryDate({
          mode: 'shelf_life',
          productionDate: productionCandidates[0].date as string,
          shelfLifeValue: fields.shelfLifeValue,
          shelfLifeUnit: fields.shelfLifeUnit,
        })
        if (calculated !== fields.expiryDate) {
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
    evidence,
  })
}

export function assignDateCandidate(
  draft: QuickEntryDraft,
  candidateIndex: number,
  role: 'expiry' | 'production',
): QuickEntryDraft {
  const candidate = draft.dateCandidates[candidateIndex]
  if (!candidate || !candidate.complete || !parseDateKey(candidate.date || '')) return draft
  const confirmationFields = (draft.confirmationFields || []).filter((field) => (
    role === 'expiry' ? !field.startsWith('date:') : field !== `date:${candidateIndex}`
  ))
  return refreshDraftValidation({
    ...draft,
    confirmationFields,
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
  return `${quantity}${location}`
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
  const issues = validateQuickEntryFields(draft.fields)
  if (draft.confirmationFields?.length) issues.push(...draft.confirmationFields.map(confirmationIssue))
  if (issues.length) return { input: null, issues }
  return { input: asInventorySaveInput(draft.fields), issues: [] }
}

export function categoryLabel(category: Category | null): string {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label || '未分类'
}
