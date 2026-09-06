export type Category = 'food' | 'medicine' | 'household' | 'other'
export type StorageLocation =
  | 'refrigerated'
  | 'frozen'
  | 'cabinet'
  | 'medicine_box'
  | 'other'
export type ExpiryInputMode = 'direct' | 'shelf_life'
export type ShelfLifeUnit = 'day' | 'month' | 'year'
export type InventoryStatus = 'active' | 'used_up' | 'discarded'
export type ExpiryStatus =
  | 'expired'
  | 'due_today'
  | 'due_in_3_days'
  | 'due_in_7_days'
  | 'safe'
export type ReminderStatus =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | null

export interface InventoryItem {
  _id: string
  name: string
  quantity: number
  unit: string
  category: Category
  storageLocation: StorageLocation
  expiryInputMode: ExpiryInputMode
  productionDate: string | null
  shelfLifeValue: number | null
  shelfLifeUnit: ShelfLifeUnit | null
  expiryDate: string
  reminderLeadDays: number
  inventoryStatus: InventoryStatus
  version: number
  createdAt?: string | Date
  updatedAt?: string | Date
  completedAt?: string | Date | null
  expiryStatus: ExpiryStatus
  daysLeft: number
  expiryStatusText: string
  expiryTone: 'danger' | 'urgent' | 'warning' | 'safe'
  categoryLabel: string
  storageLabel: string
  inventoryStatusLabel: string
  reminderStatus?: ReminderStatus
}

export interface InventoryOverview {
  expired: number
  expiringWithin7Days: number
  activeTotal: number
}

export interface InventoryListResult {
  items: InventoryItem[]
  overview: InventoryOverview
  nextCursor: string | null
  serverToday: string
}

export interface HistoryListResult {
  items: InventoryItem[]
  nextCursor: string | null
  serverToday: string
}

export interface InventorySaveInput {
  itemId?: string
  version?: number
  name: string
  quantity: number
  unit: string
  category: Category
  storageLocation: StorageLocation
  expiryInputMode: ExpiryInputMode
  productionDate: string | null
  shelfLifeValue: number | null
  shelfLifeUnit: ShelfLifeUnit | null
  expiryDate: string | null
  reminderLeadDays: number
}

export interface UserSettings {
  defaultReminderLeadDays: number
  defaultStorageLocation: StorageLocation | null
  hasReminderJobs?: boolean
}

export type ApiResult<T> =
  | { ok: true; data: T; requestId: string }
  | {
      ok: false
      error: { code: string; message: string }
      requestId: string
    }
