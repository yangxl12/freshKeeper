import {
  CATEGORY_OPTIONS,
  hasActiveInventoryConditions,
  INVENTORY_VIEW_STATUS_OPTIONS,
  groupInventoryItems,
} from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { listInventory } from '../../services/inventory-service'
import type {
  Category,
  InventoryItem,
  InventoryViewStatus,
} from '../../types/inventory'
import { millisecondsUntilShanghaiTomorrow } from '../../utils/shanghai-time'

let searchTimer: number | undefined
let midnightTimer: number | undefined
let listRequestSequence = 0

type InventoryPageItem = InventoryItem & { expiryMonth: string; expiryDay: string }

function decorateItem(item: InventoryItem): InventoryPageItem {
  const [, month, day] = item.expiryDate.split('-')
  return { ...item, expiryMonth: `${month}月`, expiryDay: day }
}

Page({
  data: {
    search: '',
    category: '' as Category | '',
    viewStatus: 'active_all' as InventoryViewStatus,
    categoryOptions: CATEGORY_OPTIONS,
    statusOptions: INVENTORY_VIEW_STATUS_OPTIONS,
    items: [] as InventoryPageItem[],
    groups: [] as Array<{
      key: string
      label: string
      tone: string
      items: InventoryPageItem[]
    }>,
    nextCursor: null as string | null,
    serverToday: '',
    loading: true,
    loadingMore: false,
    errorMessage: '',
    loadMoreError: '',
    hasActiveConditions: false,
    showGrouped: true,
    showHistory: false,
  },

  onShow() {
    const app = getApp<IAppOption>()
    const intent = app.globalData.pendingInventoryIntent
    app.globalData.pendingInventoryIntent = null
    if (intent) {
      if (searchTimer) clearTimeout(searchTimer)
      this.setData(
        {
          search: '',
          category: '',
          viewStatus: intent.viewStatus,
          hasActiveConditions: intent.viewStatus !== 'active_all',
          showGrouped: intent.viewStatus === 'active_all',
          showHistory: intent.viewStatus === 'used_up',
        },
        () => void this.refresh(true, true),
      )
    } else {
      void this.refresh(true, false)
    }
    this.scheduleMidnightRefresh()
  },

  onHide() {
    if (searchTimer) clearTimeout(searchTimer)
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  onUnload() {
    if (searchTimer) clearTimeout(searchTimer)
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  onPullDownRefresh() {
    this.refresh(true, false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.nextCursor && !this.data.loading && !this.data.loadingMore) {
      void this.refresh(false, false)
    }
  },

  scheduleMidnightRefresh() {
    if (midnightTimer) clearTimeout(midnightTimer)
    midnightTimer = setTimeout(() => {
      void this.refresh(true, false)
      this.scheduleMidnightRefresh()
    }, millisecondsUntilShanghaiTomorrow()) as unknown as number
  },

  async refresh(reset: boolean, clearExisting: boolean) {
    const requestSequence = ++listRequestSequence
    const query = {
      search: this.data.search,
      category: this.data.category,
      viewStatus: this.data.viewStatus,
    }
    if (reset) {
      this.setData({
        loading: clearExisting || this.data.items.length === 0,
        errorMessage: '',
        loadMoreError: '',
        ...(clearExisting ? { items: [], groups: [], nextCursor: null } : {}),
      })
    } else {
      this.setData({ loadingMore: true, loadMoreError: '' })
    }

    try {
      const result = await listInventory({
        ...query,
        cursor: reset ? null : this.data.nextCursor,
      })
      if (requestSequence !== listRequestSequence) return
      const pageItems = result.items.map(decorateItem)
      const items = reset ? pageItems : [...this.data.items, ...pageItems]
      const showGrouped = query.viewStatus === 'active_all'
      this.setData({
        items,
        groups: showGrouped ? groupInventoryItems(items) : [],
        nextCursor: result.nextCursor,
        serverToday: result.serverToday,
        loading: false,
        loadingMore: false,
        errorMessage: '',
        loadMoreError: '',
        hasActiveConditions: hasActiveInventoryConditions(
          query.search,
          query.category as Category | '',
          query.viewStatus,
        ),
        showGrouped,
        showHistory: query.viewStatus === 'used_up',
      })
    } catch (error) {
      if (requestSequence !== listRequestSequence) return
      const message = getErrorMessage(error)
      if (!reset) {
        this.setData({ loadingMore: false, loadMoreError: `后续库存加载失败：${message}` })
        return
      }
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: this.data.items.length ? `库存未更新：${message}` : message,
      })
    }
  },

  handleSearchInput(event: WechatMiniprogram.Input) {
    const search = event.detail.value
    this.setData({
      search,
      hasActiveConditions: hasActiveInventoryConditions(
        search,
        this.data.category,
        this.data.viewStatus,
      ),
    })
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      void this.refresh(true, true)
    }, 300) as unknown as number
  },

  clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    this.setData(
      {
        search: '',
        hasActiveConditions: hasActiveInventoryConditions(
          '',
          this.data.category,
          this.data.viewStatus,
        ),
      },
      () => void this.refresh(true, true),
    )
  },

  selectCategory(event: WechatMiniprogram.CustomEvent) {
    const category = event.currentTarget.dataset.value as Category | ''
    if (category === this.data.category) return
    this.setData(
      {
        category,
        hasActiveConditions: hasActiveInventoryConditions(
          this.data.search,
          category,
          this.data.viewStatus,
        ),
      },
      () => void this.refresh(true, true),
    )
  },

  selectStatus(event: WechatMiniprogram.CustomEvent) {
    const viewStatus = event.currentTarget.dataset.value as InventoryViewStatus
    if (viewStatus === this.data.viewStatus) return
    this.setData(
      {
        viewStatus,
        hasActiveConditions: hasActiveInventoryConditions(
          this.data.search,
          this.data.category,
          viewStatus,
        ),
        showGrouped: viewStatus === 'active_all',
        showHistory: viewStatus === 'used_up',
      },
      () => void this.refresh(true, true),
    )
  },

  resetFilters() {
    if (searchTimer) clearTimeout(searchTimer)
    this.setData(
      {
        search: '',
        category: '',
        viewStatus: 'active_all',
        hasActiveConditions: false,
        showGrouped: true,
        showHistory: false,
      },
      () => void this.refresh(true, true),
    )
  },

  openItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  addItem() {
    wx.navigateTo({ url: '/pages/item-form/index' })
  },

  handleEmptyAction() {
    if (this.data.hasActiveConditions) this.resetFilters()
    else this.addItem()
  },

  retry() {
    void this.refresh(true, false)
  },

  retryLoadMore() {
    void this.refresh(false, false)
  },
})
