import type {
  HistoryListResult,
  BatchItemReference,
  BatchMutationResult,
  InventoryItem,
  InventoryListResult,
  InventoryOverviewResult,
  InventorySaveInput,
  InventorySort,
  InventoryStatus,
  InventoryViewStatus,
  LegacyInventoryListResult,
} from '../types/inventory'
import { toInventorySaveInput } from '../domain/inventory'
import { CloudServiceError, callCloud } from './cloud-client'

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
  sort?: InventorySort
  cursor?: string | null
  pageSize?: number
} = {}): Promise<InventoryListResult> {
  return callCloud('inventoryApi', {
    action: 'listInventory',
    search: params.search || '',
    category: params.category || '',
    viewStatus: params.viewStatus || 'active_all',
    sort: params.sort || 'expiry_asc',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
}

export function getItem(itemId: string): Promise<InventoryItem> {
  return callCloud('inventoryApi', { action: 'get', itemId })
}

export function saveItem(
  input: InventorySaveInput,
  options: { idempotencyKey?: string } = {},
): Promise<{
  itemId: string
  version: number
  expiryDate: string
}> {
  return callCloud('inventoryApi', {
    action: 'save',
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    data: input,
  })
}

export function updateQuantity(
  item: InventoryItem,
  quantity: number,
): Promise<{ itemId: string; version: number; expiryDate: string }> {
  return saveItem({ ...toInventorySaveInput(item), quantity })
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

export function deleteItem(itemId: string, version: number): Promise<{ version: number }> {
  return callCloud('inventoryApi', { action: 'moveToTrash', itemId, version })
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

// 生成/补取物品 AI 封面小图。失败由调用方吞掉（封面缺失时卡片用默认占位图）。
//
// 封面是异步落库的：保存成功后物品先写入（此时没有 coverFileId），生图完成才回写。
// 首页 onShow 拉列表的时机通常早于生图完成，拿到的是没有封面的数据，而且不会自愈——
// 用户看到的就是"功能没生效"。所以这里在生成成功后广播一次，让首页把结果直接补到卡片上。
export interface ItemCoverReady {
  itemId: string
  coverFileId: string
}

type CoverListener = (cover: ItemCoverReady) => void

const coverListeners = new Set<CoverListener>()

/** 订阅封面就绪事件，返回取消订阅函数（页面 onHide/onUnload 必须调用）。 */
export function onItemCoverReady(listener: CoverListener): () => void {
  coverListeners.add(listener)
  return () => {
    coverListeners.delete(listener)
  }
}

function emitItemCoverReady(cover: ItemCoverReady) {
  coverListeners.forEach((listener) => {
    try {
      listener(cover)
    } catch (_error) {
      // 监听方异常不能影响封面主流程：对调用方而言封面始终是尽力而为。
    }
  })
}

export async function generateItemCover(itemId: string): Promise<{ coverFileId: string }> {
  const result = await callCloud<{ coverFileId: string }>('inventoryApi', {
    action: 'generateCover',
    itemId,
  })
  if (result && result.coverFileId) emitItemCoverReady({ itemId, coverFileId: result.coverFileId })
  return result
}

export function batchCompleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  return callCloud('inventoryApi', { action: 'batchComplete', items })
}

export function batchDeleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  const request = callCloud<BatchMutationResult>('inventoryApi', { action: 'batchDelete', items })
  return request.catch((error) => {
    if (!(error instanceof CloudServiceError) || error.code !== 'INVALID_ACTION') throw error
    return Promise.all(
      items.map(async (item) => {
        try {
          await deleteItem(item.itemId, item.version)
          return { itemId: item.itemId, succeeded: true as const }
        } catch (itemError) {
          const failed = itemError instanceof CloudServiceError
            ? { code: itemError.code, message: itemError.message }
            : { code: 'CLOUD_CALL_FAILED', message: '服务暂时不可用，请稍后重试' }
          return { itemId: item.itemId, succeeded: false as const, error: failed }
        }
      }),
    ).then((results) => ({
      succeeded: results.filter((result) => result.succeeded).map((result) => result.itemId),
      failed: results
        .filter((result) => !result.succeeded)
        .map((result) => ({ itemId: result.itemId, ...result.error })),
    }))
  })
}

export function batchPermanentlyDeleteItems(items: BatchItemReference[]): Promise<BatchMutationResult> {
  return callCloud('inventoryApi', { action: 'batchPermanentDelete', items })
}

export function listTrash(params: {
  search?: string
  cursor?: string | null
  pageSize?: number
} = {}): Promise<HistoryListResult> {
  const request = callCloud<HistoryListResult>('inventoryApi', {
    action: 'listTrash',
    search: params.search || '',
    cursor: params.cursor || null,
    pageSize: params.pageSize || 30,
  })
  return request.catch((error) => {
    // Keep existing deployments usable while the new listTrash action rolls out.
    if (!(error instanceof CloudServiceError) || error.code !== 'INVALID_ACTION') throw error
    return listHistory({
      search: params.search,
      status: 'discarded',
      cursor: params.cursor,
      pageSize: params.pageSize,
    })
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
