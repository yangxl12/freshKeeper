import type {
  Category,
  ExpiryInputMode,
  InventorySaveInput,
  ShelfLifeUnit,
} from './inventory'

export type QuickEntrySource = 'recent' | 'text' | 'voice' | 'date_photo' | 'manual'

export type QuickDraftStatus =
  | 'recognizing'
  | 'needs_input'
  | 'needs_confirmation'
  | 'savable'
  | 'saving'
  | 'saved'
  | 'failed'

export type QuickDraftIssueCode =
  | 'MISSING_NAME'
  | 'MISSING_EXPIRY'
  | 'INVALID_FIELD'
  | 'AMBIGUOUS_DATE'
  | 'DATE_CONFLICT'
  | 'UNSUPPORTED_OPENED_PERIOD'
  | 'OCR_NO_DATE'
  | 'TOO_MANY_DRAFTS'
  | 'SERVICE_UNAVAILABLE'

export interface QuickEntryDraftFields {
  name: string
  quantity: number | null
  unit: string
  category: Category | null
  storageLocation: string
  expiryInputMode: ExpiryInputMode
  productionDate: string | null
  shelfLifeValue: number | null
  shelfLifeUnit: ShelfLifeUnit | null
  expiryDate: string | null
  reminderLeadDays: number | null
  /** 本次入库是否顺带开启到期提醒（本地意向，真正授权发生在保存成功那一刻）。 */
  remindAfterSave: boolean
}

export interface DateCandidate {
  date: string | null
  role: 'expiry' | 'production' | 'unknown'
  rawText: string
  complete: boolean
  source: 'text' | 'photo'
}

export interface QuickEntryDraftIssue {
  code: QuickDraftIssueCode
  field?: string
  message: string
}

export interface QuickEntryDraft {
  draftId: string
  saveKey: string
  source: QuickEntrySource
  status: QuickDraftStatus
  fields: QuickEntryDraftFields
  issues: QuickEntryDraftIssue[]
  selected: boolean
  dateCandidates: DateCandidate[]
  confirmationFields?: string[]
  expanded?: boolean
  evidence?: { kind: 'text' | 'photo'; localPath?: string; sourceText?: string }
  /** 云端解析器版本；以 `ai-` 开头表示这条草稿来自大模型。 */
  parserVersion?: string
  /** AI 在原文里没找到、已按默认值填充的字段，仅用于提示用户确认。 */
  aiMissingFields?: string[]
  errorMessage?: string
  submittedInput?: InventorySaveInput
  dateConflict?: string
  dateInvalid?: boolean
}

export interface RecentItemProfile {
  name: string
  quantity: number
  unit: string
  category: Category
  storageLocation: string
  reminderLeadDays: number
  expiryInputMode: ExpiryInputMode
  shelfLifeValue: number | null
  shelfLifeUnit: ShelfLifeUnit | null
  invalidFields?: string[]
}

export interface QuickEntryParseResult {
  items: Array<{
    name?: string
    quantity?: number
    unit?: string
    category?: Category
    storageLocation?: string
    expiryInputMode?: ExpiryInputMode
    shelfLifeValue?: number
    shelfLifeUnit?: ShelfLifeUnit
    dateCandidates?: DateCandidate[]
  }>
  serverToday: string
  parserVersion: string
}

export interface QuickEntryCapabilities {
  text: boolean
  voice: boolean
  datePhoto: boolean
  /** 云端文字解析走大模型；false 或缺失时页面按确定性规则识别展示。 */
  aiText?: boolean
}

export interface DatePhotoResult {
  candidates: DateCandidate[]
  shelfLifeValue?: number
  shelfLifeUnit?: ShelfLifeUnit
  sourceText?: string
  unsupported?: 'opened_period'
  serverToday: string
}

export function asInventorySaveInput(fields: QuickEntryDraftFields): InventorySaveInput {
  return {
    name: fields.name.trim(),
    quantity: fields.quantity as number,
    unit: fields.unit.trim(),
    category: fields.category as Category,
    storageLocation: fields.storageLocation.trim(),
    expiryInputMode: fields.expiryInputMode,
    productionDate: fields.expiryInputMode === 'shelf_life' ? fields.productionDate : null,
    shelfLifeValue: fields.expiryInputMode === 'shelf_life' ? fields.shelfLifeValue : null,
    shelfLifeUnit: fields.expiryInputMode === 'shelf_life' ? fields.shelfLifeUnit : null,
    expiryDate: fields.expiryInputMode === 'direct' ? fields.expiryDate : null,
    reminderLeadDays: fields.reminderLeadDays as number,
  }
}
