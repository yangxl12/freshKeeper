import type {
  Category,
  ExpiryStatus,
  InventoryItem,
  InventoryStatus,
  ShelfLifeUnit,
  StorageLocation,
} from '../types/inventory'

export const CATEGORY_OPTIONS: ReadonlyArray<{ value: Category | ''; label: string }> = [
  { value: '', label: '全部分类' },
  { value: 'food', label: '食品' },
  { value: 'medicine', label: '药品' },
  { value: 'household', label: '日化' },
  { value: 'other', label: '其他' },
]

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

export const HISTORY_STATUS_OPTIONS: ReadonlyArray<{
  value: InventoryStatus | ''
  label: string
}> = [
  { value: '', label: '全部' },
  { value: 'used_up', label: '已用完' },
  { value: 'discarded', label: '已丢弃' },
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
