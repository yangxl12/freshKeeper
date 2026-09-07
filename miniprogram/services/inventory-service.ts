import type {
  HistoryListResult,
  BatchItemReference,
  BatchMutationResult,
  InventoryItem,
  InventoryListResult,
  InventoryOverviewResult,
  InventorySaveInput,
  InventoryStatus,
  InventoryViewStatus,
  LegacyInventoryListResult,
} from '../types/inventory'
import { callCloud } from './cloud-client'

export interface ListActiveParams {
  search?: string
  category?: string
  storageLocation?: string
  cursor?: string | null
  pageSize?: number
}

export function listActive(params: ListActiveParams = {}): Promise<LegacyInventoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listActive',
    search: params.search || '',
    category: params.category || '',
    storageLocation: params.storageLocation || '',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
}

export function getOverview(): Promise<InventoryOverviewResult> {
  return callCloud('inventoryApi', { action: 'getOverview' })
}

export function listInventory(params: {
  search?: string
  category?: string
  viewStatus?: InventoryViewStatus
  cursor?: string | null
  pageSize?: number
} = {}): Promise<InventoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listInventory',
    search: params.search || '',
    category: params.category || '',
    viewStatus: params.viewStatus || 'active_all',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
}

export function getItem(itemId: string): Promise<InventoryItem> {
  return callCloud('inventoryApi', { action: 'get', itemId })
}

export function saveItem(input: InventorySaveInput): Promise<{
  itemId: string
  version: number
  expiryDate: string
}> {
  return callCloud('inventoryApi', { action: 'save', data: input })
}

export function decrementItem(
  itemId: string,
  version: number,
  amount: number,
): Promise<{ quantity: number; version: number }> {
  return callCloud('inventoryApi', { action: 'decrement', itemId, version, amount })
}

export function completeItem(
  itemId: string,
  version: number,
): Promise<{ version: number }> {
  return callCloud('inventoryApi', { action: 'complete', itemId, version })
}

export function discardItem(
  itemId: string,
  version: number,
): Promise<{ version: number }> {
  return callCloud('inventoryApi', { action: 'discard', itemId, version })
}

export function deleteItem(itemId: string, version: number): Promise<{ version: number }> {
  return callCloud('inventoryApi', { action: 'delete', itemId, version })
}

export function permanentlyDeleteItem(itemId: string, version: number): Promise<{ deleted: true }> {
  return callCloud('inventoryApi', { action: 'permanentDelete', itemId, version })
}

export function restoreItem(input: InventorySaveInput): Promise<{
  itemId: string
  version: number
  expiryDate: string
}> {
  return callCloud('inventoryApi', { action: 'restore', data: input })
}

export function batchCompleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  return callCloud('inventoryApi', { action: 'batchComplete', items })
}

export function batchDeleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  return callCloud('inventoryApi', { action: 'batchDelete', items })
}

export function batchPermanentlyDeleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  return callCloud('inventoryApi', { action: 'batchPermanentDelete', items })
}

export function listTrash(params: {
  search?: string
  cursor?: string | null
  pageSize?: number
} = {}): Promise<HistoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listTrash',
    search: params.search || '',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
}

export function listHistory(params: {
  search?: string
  status?: InventoryStatus | ''
  cursor?: string | null
  pageSize?: number
}): Promise<HistoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listHistory',
    search: params.search || '',
    status: params.status || '',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
}
