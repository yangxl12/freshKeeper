import type {
  HistoryListResult,
  InventoryItem,
  InventoryListResult,
  InventorySaveInput,
  InventoryStatus,
} from '../types/inventory'
import { callCloud } from './cloud-client'

export interface ListActiveParams {
  search?: string
  category?: string
  storageLocation?: string
  cursor?: string | null
  pageSize?: number
}

export function listActive(params: ListActiveParams = {}): Promise<InventoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listActive',
    search: params.search || '',
    category: params.category || '',
    storageLocation: params.storageLocation || '',
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
): Promise<{ quantity: number; version: number }> {
  return callCloud('inventoryApi', { action: 'decrement', itemId, version })
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

export function deleteItem(itemId: string, version: number): Promise<{ deleted: true }> {
  return callCloud('inventoryApi', { action: 'delete', itemId, version })
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
