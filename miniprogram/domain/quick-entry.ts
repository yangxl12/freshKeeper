import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from './inventory'
import type { Category } from '../types/inventory'
import type {
  QuickEntryDraft,
  QuickEntryDraftFields,
  QuickEntryDraftIssue,
  RecentItemProfile,
} from '../types/quick-entry'
import { asInventorySaveInput } from '../types/quick-entry'
import { calculateExpiryDate, parseDateKey } from '../utils/date-key'

export function normalizeRecentName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z]/g, (letter) => letter.toLowerCase())
}

export function createSaveKey(): string {
  const random = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${random()}-${random()}-4${random().slice(1, 4)}-${random().slice(0, 4)}-${random()}${random().slice(0, 4)}`
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
  const quantityValid = Number.isInteger(profile.quantity) && profile.quantity >= 1
  const quantity = quantityValid ? profile.quantity : 1
  const category = CATEGORY_OPTIONS.some((option) => option.value === profile.category)
    ? profile.category
    : 'food'
  const expiryInputMode = profile.expiryInputMode === 'shelf_life' ? 'shelf_life' : 'direct'
  const fields: QuickEntryDraftFields = {
    ...defaultQuickEntryFields(reminderLeadDays),
    name: profile.name,
    quantity,
    unit: profile.unit || '件',
    category,
    storageLocation: profile.storageLocation || '',
    expiryInputMode,
    shelfLifeValue: expiryInputMode === 'shelf_life' ? profile.shelfLifeValue : null,
    shelfLifeUnit: expiryInputMode === 'shelf_life' ? profile.shelfLifeUnit || 'day' : null,
    productionDate: null,
    expiryDate: null,
    reminderLeadDays: Number.isInteger(profile.reminderLeadDays) ? profile.reminderLeadDays : reminderLeadDays,
  }
  const issues = validateQuickEntryFields(fields)
  if (!quantityValid) {
    issues.push(issue('INVALID_FIELD', 'quantity', '原记录数量无效，已改为 1，请确认'))
  }
  return {
    draftId: createSaveKey(),
    saveKey: createSaveKey(),
    source: 'recent',
    status: issues.length ? (quantityValid ? 'needs_input' : 'needs_confirmation') : 'savable',
    fields,
    issues,
    selected: !issues.length,
    dateCandidates: [],
    confirmationFields: quantityValid ? [] : ['quantity'],
  }
}

export function refreshDraftValidation(draft: QuickEntryDraft): QuickEntryDraft {
  const issues = validateQuickEntryFields(draft.fields)
  if (draft.confirmationFields?.includes('quantity')) {
    issues.push(issue('INVALID_FIELD', 'quantity', '原记录数量无效，已改为 1，请确认'))
  }
  return {
    ...draft,
    issues,
    status: draft.status === 'saved' || draft.status === 'saving'
      ? draft.status
      : draft.confirmationFields?.length
        ? 'needs_confirmation'
        : issues.length
          ? 'needs_input'
          : 'savable',
    selected: issues.length ? false : draft.selected,
    errorMessage: undefined,
  }
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
  if (draft.confirmationFields?.length) {
    issues.push(issue('INVALID_FIELD', 'quantity', '请确认原记录中的修正字段'))
  }
  if (issues.length) return { input: null, issues }
  return { input: asInventorySaveInput(draft.fields), issues: [] }
}

export function categoryLabel(category: Category | null): string {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label || '未分类'
}
