import type {
  Category,
  ExpiryStatus,
  InventoryItem,
  InventorySaveInput,
  InventorySort,
  InventoryViewStatus,
  ShelfLifeUnit,
  StorageLocation,
} from '../types/inventory'

export const CATEGORY_OPTIONS: ReadonlyArray<{ value: Category | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'food', label: '食品' },
  { value: 'medicine', label: '药品' },
  { value: 'household', label: '日化' },
  { value: 'other', label: '其他' },
]

export const INVENTORY_VIEW_STATUS_OPTIONS: ReadonlyArray<{
  value: InventoryViewStatus
  label: string
}> = [
  { value: 'active_all', label: '全部在库' },
  { value: 'expiring', label: '临期' },
  { value: 'expired', label: '已过期' },
  { value: 'safe', label: '状态良好' },
  { value: 'used_up', label: '已用完' },
]

export const DEFAULT_INVENTORY_SORT: InventorySort = 'expiry_asc'

export const INVENTORY_SORT_OPTIONS: ReadonlyArray<{ value: InventorySort; label: string }> = [
  { value: 'expiry_asc', label: '过期正序' },
  { value: 'expiry_desc', label: '过期倒序' },
  { value: 'created_asc', label: '录入正序' },
  { value: 'created_desc', label: '录入倒序' },
]

export const HOME_CARD_VIEW_STATUS = {
  activeTotal: 'active_all',
  expired: 'expired',
  expiringWithin7Days: 'expiring',
  usedUpTotal: 'used_up',
} as const satisfies Record<string, InventoryViewStatus>

export const MAX_ITEM_QUANTITY = 9999

export type InventoryCardItem = InventoryItem & {
  expiryDateText: string
  remainingDaysText: string
  quantityText: string
  locationText: string
  hasLocation: boolean
  isActive: boolean
}

export function toInventoryCardItem(item: InventoryItem): InventoryCardItem {
  const [year, month, day] = item.expiryDate.split('-')
  let remainingDaysText = `剩余 ${item.daysLeft} 天`
  if (item.daysLeft < 0) remainingDaysText = `已过期 ${Math.abs(item.daysLeft)} 天`
  if (item.daysLeft === 0) remainingDaysText = '今天到期'
  const location = typeof item.storageLocation === 'string' ? item.storageLocation.trim() : ''
  const locationText = location ? item.storageLabel || location : ''

  return {
    ...item,
    expiryDateText: `${year}年${month}月${day}日`,
    remainingDaysText,
    quantityText: `${item.quantity}${item.unit}`,
    locationText,
    hasLocation: Boolean(locationText),
    isActive: item.inventoryStatus === 'active',
  }
}

export function hasActiveInventoryConditions(
  search: string,
  category: Category | '',
  viewStatus: InventoryViewStatus,
) {
  return Boolean(search.trim() || category || viewStatus !== 'active_all')
}

/** 只保留数字并去掉前导 0，最多 4 位，保证数量输入不出现负数或非法字符 */
export function sanitizeQuantityInput(raw: string): string {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '')
  return digits.replace(/^0+(?=\d)/, '').slice(0, 4)
}

/** 解析为 1～9999 的正整数，无法解析时返回 null */
export function parseQuantity(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 && value <= MAX_ITEM_QUANTITY ? value : null
}

/** 按 ±1 步进，结果始终落在 1～9999 */
export function stepQuantity(current: number, delta: number): number {
  const base = Number.isInteger(current) && current >= 1 ? current : 1
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, base + delta))
}

export function toInventorySaveInput(item: InventoryItem): InventorySaveInput {
  return {
    itemId: item._id,
    version: item.version,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    category: item.category,
    storageLocation: item.storageLocation || '',
    expiryInputMode: item.expiryInputMode,
    productionDate: item.productionDate || null,
    shelfLifeValue: item.shelfLifeValue ?? null,
    shelfLifeUnit: item.shelfLifeUnit ?? null,
    expiryDate: item.expiryDate || null,
    reminderLeadDays: item.reminderLeadDays,
  }
}

export const STORAGE_OPTIONS: ReadonlyArray<{
  value: StorageLocation | ''
  label: string
}> = [
  { value: '', label: '全部位置' },
  { value: 'refrigerated', label: '冷藏' },
  { value: 'frozen', label: '冷冻' },
  { value: 'cabinet', label: '橱柜' },
  { value: 'medicine_box', label: '药箱' },
  { value: 'other', label: '其他' },
]

export const SHELF_LIFE_OPTIONS: ReadonlyArray<{
  value: ShelfLifeUnit
  label: string
}> = [
  { value: 'day', label: '天' },
  { value: 'month', label: '个月' },
  { value: 'year', label: '年' },
]

export const EXPIRY_GROUPS: ReadonlyArray<{
  key: ExpiryStatus
  label: string
  tone: string
}> = [
  { key: 'expired', label: '已过期', tone: 'danger' },
  { key: 'due_today', label: '今天到期', tone: 'urgent' },
  { key: 'due_in_3_days', label: '3 天内到期', tone: 'urgent' },
  { key: 'due_in_7_days', label: '7 天内到期', tone: 'warning' },
  { key: 'safe', label: '暂时安全', tone: 'safe' },
]

export function groupInventoryItems<T extends InventoryItem>(items: T[]) {
  return EXPIRY_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.expiryStatus === group.key),
  })).filter((group) => group.items.length > 0)
}
