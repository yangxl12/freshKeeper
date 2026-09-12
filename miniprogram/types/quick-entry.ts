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

/**
 * 草稿卡片的展示派生值。
 *
 * 故意挂在草稿对象上（`draft.view`）而不是拆成一堆平行数组：
 * 平行数组按索引与 `drafts` 隐式对齐，任何一次 filter / 插入都会让卡片串位。
 * 由页面在每次草稿变更后重算，不入库、不参与保存。
 */
export interface QuickEntryDraftView {
  statusLabel: string
  statusTone: string
  sourceLabel: string
  aiFlag: boolean
  aiMissingHint: string
  nameMissing: boolean
  expirySummary: string
  expiryBadge: string
  expiryTone: 'fresh' | 'soon' | 'expired' | 'empty'
  expired: boolean
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
  /** 卡片展示派生值；由页面重算，云端不存。 */
  view?: QuickEntryDraftView
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
