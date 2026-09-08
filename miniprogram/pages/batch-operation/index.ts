import { toInventoryCardItem, type InventoryCardItem } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import {
  batchCompleteItems,
  batchDeleteItems,
  batchPermanentlyDeleteItems,
  listInventory,
  listTrash,
} from '../../services/inventory-service'
import type {
  BatchItemReference,
  BatchMutationResult,
  Category,
  InventoryListResult,
  InventoryViewStatus,
} from '../../types/inventory'

type BatchSource = 'home' | 'inventory' | 'trash'
type BatchListItem = InventoryCardItem & { selected: boolean }
interface BatchIntent {
  source: BatchSource
  search?: string
  category?: Category | ''
  viewStatus?: InventoryViewStatus
}

const CHUNK_SIZE = 20

const VIEW_STATUS_TITLE: Record<InventoryViewStatus, string> = {
  active_all: '全部在库批量操作',
  expiring: '临期物品批量操作',
  expired: '已过期物品批量操作',
  safe: '状态良好物品批量操作',
  used_up: '已用完物品批量操作',
}

/** 入口来源 + 当前筛选状态决定本页在批量什么数据；导航栏标题固定为“批量操作”。 */
function resolveScopeTitle(source: BatchSource, viewStatus: InventoryViewStatus) {
  return source === 'trash' ? '回收站批量操作' : VIEW_STATUS_TITLE[viewStatus] || VIEW_STATUS_TITLE.active_all
}

Page({
  data: {
    source: 'inventory' as BatchSource,
    viewStatus: 'active_all' as InventoryViewStatus,
    title: '批量操作',
    items: [] as BatchListItem[],
    selectedCount: 0,
    allSelected: false,
    loading: true,
    operating: false,
    errorMessage: '',
    canComplete: true,
  },

  onLoad(options: Record<string, string | undefined>) {
    const source = (options.source || 'inventory') as BatchSource
    const app = getApp<IAppOption>()
    const intent = app.globalData.pendingBatchIntent
    if (intent?.source === source) app.globalData.pendingBatchIntent = null
    const viewStatus: InventoryViewStatus = intent?.viewStatus || (source === 'home' ? 'expiring' : 'active_all')
    const canComplete = source !== 'trash' && viewStatus !== 'used_up'
    const title = resolveScopeTitle(source, viewStatus)
    this.setData({ source, title, viewStatus, canComplete })
    wx.setNavigationBarTitle({ title: '批量操作' })
    void this.loadAll({ ...(intent || {}), source, viewStatus })
  },

  async loadAll(intent: BatchIntent) {
    this.setData({ loading: true, errorMessage: '', items: [], selectedCount: 0, allSelected: false })
    try {
      let cursor: string | null = null
      const items: BatchListItem[] = []
      do {
        const result: InventoryListResult = intent.source === 'trash'
          ? await listTrash({ cursor })
          : await listInventory({
              search: intent.search || '',
              category: intent.category || '',
              viewStatus: intent.viewStatus || (intent.source === 'home' ? 'expiring' : 'active_all'),
              cursor,
            })
        items.push(...result.items.map((item: import('../../types/inventory').InventoryItem) => ({
          ...toInventoryCardItem(item),
          selected: false,
        })))
        cursor = result.nextCursor
        this.setData({ items: [...items] })
      } while (cursor)
      this.setData({ loading: false })
    } catch (error) {
      this.setData({ loading: false, errorMessage: getErrorMessage(error) })
    }
  },

  toggleItem(event: WechatMiniprogram.BaseEvent) {
    if (this.data.operating || this.data.loading) return
    const itemId = String(event.currentTarget.dataset.id || '')
    const items = this.data.items.map((item) =>
      item._id === itemId ? { ...item, selected: !item.selected } : item,
    )
    this.updateSelection(items)
  },

  toggleAll() {
    if (this.data.operating || this.data.loading || !this.data.items.length) return
    const selected = !this.data.allSelected
    this.updateSelection(this.data.items.map((item) => ({ ...item, selected })))
  },

  updateSelection(items: BatchListItem[]) {
    const selectedCount = items.filter((item) => item.selected).length
    this.setData({
      items,
      selectedCount,
      allSelected: items.length > 0 && selectedCount === items.length,
    })
  },

  selectedItems(): BatchItemReference[] {
    return this.data.items
      .filter((item) => item.selected)
      .map((item) => ({ itemId: item._id, version: item.version }))
  },

  async runInChunks(
    items: BatchItemReference[],
    operation: (chunk: BatchItemReference[]) => Promise<BatchMutationResult>,
  ) {
    const result: BatchMutationResult = { succeeded: [], failed: [] }
    for (let index = 0; index < items.length; index += CHUNK_SIZE) {
      const chunkResult = await operation(items.slice(index, index + CHUNK_SIZE))
      result.succeeded.push(...chunkResult.succeeded)
      result.failed.push(...chunkResult.failed)
    }
    return result
  },

  async completeSelected() {
    const selected = this.selectedItems()
    if (!selected.length || !this.data.canComplete || this.data.operating) return
    await this.perform(selected, batchCompleteItems, '已标记为用完')
  },

  async deleteSelected() {
    const selected = this.selectedItems()
    if (!selected.length || this.data.operating) return
    const permanent = this.data.source === 'trash'
    const modal = await wx.showModal({
      title: permanent ? `彻底删除 ${selected.length} 项？` : `删除 ${selected.length} 项？`,
      content: permanent ? '彻底删除后无法恢复。' : '删除后会移入回收站，保留 30 天。',
      confirmText: permanent ? '彻底删除' : '删除',
      confirmColor: '#A33F32',
    })
    if (!modal.confirm) return
    await this.perform(
      selected,
      permanent ? batchPermanentlyDeleteItems : batchDeleteItems,
      permanent ? '已彻底删除' : '已移入回收站',
    )
  },

  async perform(
    selected: BatchItemReference[],
    operation: (chunk: BatchItemReference[]) => Promise<BatchMutationResult>,
    successText: string,
  ) {
    this.setData({ operating: true })
    try {
      const result = await this.runInChunks(selected, operation)
      if (result.failed.length) {
        const succeededText = result.succeeded.length ? `已完成 ${result.succeeded.length} 项，` : ''
        await wx.showModal({
          title: '部分操作未完成',
          content: `${succeededText}${result.failed.length} 项因数据已更新而失败，请返回列表后重试。`,
          showCancel: false,
        })
      } else {
        wx.showToast({ title: successText, icon: 'success' })
      }
      const succeeded = new Set(result.succeeded)
      this.updateSelection(this.data.items.filter((item) => !succeeded.has(item._id)))
      this.setData({ operating: false })
    } catch (error) {
      this.setData({ operating: false })
      wx.showToast({ title: getErrorMessage(error), icon: 'none', duration: 2500 })
    }
  },

  cancel() {
    if (!this.data.operating) wx.navigateBack()
  },
})
