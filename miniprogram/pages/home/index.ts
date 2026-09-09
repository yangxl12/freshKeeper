import {
  CATEGORY_OPTIONS,
  DEFAULT_INVENTORY_SORT,
  hasActiveInventoryConditions,
  HOME_CARD_VIEW_STATUS,
  INVENTORY_SORT_OPTIONS,
  INVENTORY_VIEW_STATUS_OPTIONS,
  MAX_ITEM_QUANTITY,
  parseQuantity,
  sanitizeQuantityInput,
  stepQuantity,
  toInventoryCardItem,
  type InventoryCardItem,
} from '../../domain/inventory'
import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  deleteItem,
  getOverview,
  listInventory,
  updateQuantity,
} from '../../services/inventory-service'
import { armReminder, requestReminderAuthorization } from '../../services/reminder-service'
import type {
  Category,
  InventoryOverviewResult,
  InventorySort,
  InventoryViewStatus,
} from '../../types/inventory'
import { track } from '../../utils/analytics'
import { millisecondsUntilShanghaiTomorrow } from '../../utils/shanghai-time'

interface QuantitySheet {
  visible: boolean
  itemId: string
  name: string
  unit: string
  value: string
}

interface MoreSheet {
  visible: boolean
  itemId: string
  name: string
}

type MoreAction = 'complete' | 'delete' | 'remind'

let searchTimer: number | undefined
let midnightTimer: number | undefined
let listRequestSequence = 0
let overviewRequestSequence = 0

function emptyQuantitySheet(): QuantitySheet {
  return { visible: false, itemId: '', name: '', unit: '', value: '1' }
}

function emptyMoreSheet(): MoreSheet {
  return { visible: false, itemId: '', name: '' }
}

Page({
  data: {
    headerTop: 48,
    titleWidth: 200,
    loading: true,
    refreshing: false,
    errorMessage: '',
    listErrorMessage: '',
    overview: null as InventoryOverviewResult | null,
    search: '',
    category: '' as Category | '',
    viewStatus: 'active_all' as InventoryViewStatus,
    sort: DEFAULT_INVENTORY_SORT as InventorySort,
    categoryOptions: CATEGORY_OPTIONS,
    statusOptions: INVENTORY_VIEW_STATUS_OPTIONS,
    sortOptions: INVENTORY_SORT_OPTIONS,
    items: [] as InventoryCardItem[],
    nextCursor: null as string | null,
    loadingMore: false,
    loadMoreError: '',
    hasActiveConditions: false,
    actionLoading: false,
    quantitySheet: emptyQuantitySheet(),
    moreSheet: emptyMoreSheet(),
  },

  onLoad() {
    const windowInfo = wx.getWindowInfo()
    const capsule = wx.getMenuButtonBoundingClientRect()
    this.setData({
      headerTop: capsule.top || (windowInfo.statusBarHeight + 8),
      titleWidth: capsule.left > 0 ? capsule.left - 36 : windowInfo.windowWidth - 140,
    })
  },

  editMoreItem() {
    const itemId = this.data.moreSheet.itemId
    this.closeMore()
    wx.navigateTo({ url: `/pages/item-form/index?id=${itemId}` })
  },

  onShow() {
    this.syncTabBar()
    void this.refreshOverview()
    void this.refresh(true, false)
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
    this.setData({ refreshing: true })
    Promise.all([this.refreshOverview(), this.refresh(true, false)]).finally(() => {
      this.setData({ refreshing: false })
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    if (this.data.nextCursor && !this.data.loading && !this.data.loadingMore) {
      void this.refresh(false, false)
    }
  },

  scheduleMidnightRefresh() {
    if (midnightTimer) clearTimeout(midnightTimer)
    midnightTimer = setTimeout(() => {
      void this.refreshOverview()
      void this.refresh(true, false)
      this.scheduleMidnightRefresh()
    }, millisecondsUntilShanghaiTomorrow()) as unknown as number
  },

  syncTabBar() {
    const tabBar = (
      this as unknown as {
        getTabBar?: () => { setData?: (data: Record<string, unknown>) => void } | undefined
      }
    ).getTabBar?.()
    tabBar?.setData?.({ selected: 0 })
  },

  async refreshOverview() {
    const requestSequence = ++overviewRequestSequence
    try {
      const overview = await getOverview()
      if (requestSequence !== overviewRequestSequence) return
      this.setData({ overview, errorMessage: '' })
    } catch (error) {
      if (requestSequence !== overviewRequestSequence) return
      if (this.data.overview) return
      this.setData({ errorMessage: getErrorMessage(error) })
    }
  },

  async refresh(reset: boolean, clearExisting: boolean) {
    const requestSequence = ++listRequestSequence
    const query = {
      search: this.data.search,
      category: this.data.category,
      viewStatus: this.data.viewStatus,
      sort: this.data.sort,
    }
    if (reset) {
      this.setData({
        loading: clearExisting || this.data.items.length === 0,
        listErrorMessage: '',
        loadMoreError: '',
        ...(clearExisting ? { items: [], nextCursor: null } : {}),
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
      const pageItems = result.items.map(toInventoryCardItem)
      this.setData({
        items: reset ? pageItems : [...this.data.items, ...pageItems],
        nextCursor: result.nextCursor,
        loading: false,
        loadingMore: false,
        listErrorMessage: '',
        loadMoreError: '',
        hasActiveConditions: hasActiveInventoryConditions(
          query.search,
          query.category as Category | '',
          query.viewStatus,
        ),
      })
    } catch (error) {
      if (requestSequence !== listRequestSequence) return
      const message = getErrorMessage(error)
      if (!reset) {
        this.setData({ loadingMore: false, loadMoreError: `后续物品加载失败：${message}` })
        return
      }
      this.setData({
        loading: false,
        loadingMore: false,
        listErrorMessage: this.data.items.length ? `列表未更新：${message}` : message,
      })
    }
  },

  applyFilters() {
    if (searchTimer) clearTimeout(searchTimer)
    this.setData(
      {
        hasActiveConditions: hasActiveInventoryConditions(
          this.data.search,
          this.data.category,
          this.data.viewStatus,
        ),
      },
      () => void this.refresh(true, true),
    )
  },

  handleSearchInput(event: WechatMiniprogram.Input) {
    this.setData({ search: event.detail.value })
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => this.applyFilters(), 300) as unknown as number
  },

  clearSearch() {
    this.setData({ search: '' }, () => this.applyFilters())
  },

  selectCategory(event: WechatMiniprogram.CustomEvent) {
    const category = event.currentTarget.dataset.value as Category | ''
    if (category === this.data.category) return
    this.setData({ category }, () => this.applyFilters())
  },

  selectStatus(event: WechatMiniprogram.CustomEvent) {
    const viewStatus = event.currentTarget.dataset.value as InventoryViewStatus
    if (viewStatus === this.data.viewStatus) return
    this.setData({ viewStatus }, () => this.applyFilters())
  },

  selectSort(event: WechatMiniprogram.CustomEvent) {
    const sort = event.currentTarget.dataset.value as InventorySort
    if (sort === this.data.sort) return
    this.setData({ sort }, () => this.applyFilters())
  },

  selectOverviewCard(event: WechatMiniprogram.CustomEvent) {
    const card = event.currentTarget.dataset.card as keyof typeof HOME_CARD_VIEW_STATUS
    const viewStatus = HOME_CARD_VIEW_STATUS[card]
    if (!viewStatus) return
    this.setData({ viewStatus }, () => this.applyFilters())
  },

  resetFilters() {
    this.setData(
      {
        search: '',
        category: '',
        viewStatus: 'active_all',
        sort: DEFAULT_INVENTORY_SORT,
        hasActiveConditions: false,
      },
      () => this.applyFilters(),
    )
  },

  findItem(itemId: string) {
    return this.data.items.find((item) => item._id === itemId)
  },

  openItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  editItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-form/index?id=${event.detail.itemId}` })
  },

  openQuantity(event: WechatMiniprogram.CustomEvent<{ itemId: string; delta?: number }>) {
    const item = this.findItem(event.detail.itemId)
    if (!item) return
    this.setData({
      quantitySheet: {
        visible: true,
        itemId: item._id,
        name: item.name,
        unit: item.unit,
        value: String(stepQuantity(item.quantity, event.detail.delta === 1 ? 1 : event.detail.delta === -1 ? -1 : 0)),
      },
    })
  },

  closeQuantity() {
    this.setData({ quantitySheet: emptyQuantitySheet() })
  },

  handleQuantityInput(event: WechatMiniprogram.Input) {
    this.setData({ 'quantitySheet.value': sanitizeQuantityInput(event.detail.value) })
  },

  stepQuantity(event: WechatMiniprogram.CustomEvent) {
    const delta = Number(event.currentTarget.dataset.delta)
    if (delta !== 1 && delta !== -1) return
    const current = parseQuantity(this.data.quantitySheet.value) ?? 0
    this.setData({ 'quantitySheet.value': String(stepQuantity(current, delta)) })
  },

  async submitQuantity() {
    const sheet = this.data.quantitySheet
    const item = this.findItem(sheet.itemId)
    if (!item) {
      this.closeQuantity()
      return
    }
    const quantity = parseQuantity(sheet.value)
    if (quantity === null) {
      wx.showToast({ title: `请输入 1～${MAX_ITEM_QUANTITY} 的整数`, icon: 'none' })
      return
    }
    if (quantity === item.quantity) {
      this.closeQuantity()
      return
    }
    if (this.data.actionLoading) return

    this.setData({ actionLoading: true })
    try {
      const result = await updateQuantity(item, quantity)
      this.setData({ actionLoading: false })
      this.closeQuantity()
      this.patchItem(item._id, { quantity, version: result.version })
      wx.showToast({ title: `数量已改为 ${quantity}${item.unit}`, icon: 'success' })
    } catch (error) {
      this.handleActionError(error)
    }
  },

  patchItem(itemId: string, patch: Partial<InventoryCardItem>) {
    const index = this.data.items.findIndex((item) => item._id === itemId)
    if (index < 0) return
    const merged = toInventoryCardItem({ ...this.data.items[index], ...patch } as InventoryCardItem)
    this.setData({ [`items[${index}]`]: merged })
  },

  openMore(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    const item = this.findItem(event.detail.itemId)
    if (!item) return
    this.setData({ moreSheet: { visible: true, itemId: item._id, name: item.name } })
  },

  closeMore() {
    this.setData({ moreSheet: emptyMoreSheet() })
  },

  async handleMoreAction(event: WechatMiniprogram.CustomEvent) {
    const action = event.currentTarget.dataset.action as MoreAction
    const item = this.findItem(this.data.moreSheet.itemId)
    if (!item) {
      this.closeMore()
      return
    }
    if (action === 'complete') await this.completeItemAction(item)
    else if (action === 'delete') await this.deleteItemAction(item)
    else await this.remindItem(item)
  },

  async completeItemAction(item: InventoryCardItem) {
    if (this.data.actionLoading) return
    const modal = await wx.showModal({
      title: '标记为已用完？',
      content: '物品会从当前库存移入已用完记录。',
      confirmText: '已用完',
      confirmColor: '#245B49',
    })
    if (!modal.confirm) return
    this.setData({ actionLoading: true })
    try {
      await completeItem(item._id, item.version)
      track('item_used_up')
      this.setData({ actionLoading: false })
      this.closeMore()
      wx.showToast({ title: '已标记为用完', icon: 'success' })
      void this.refreshOverview()
      void this.refresh(true, false)
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async deleteItemAction(item: InventoryCardItem) {
    if (this.data.actionLoading) return
    const modal = await wx.showModal({
      title: '删除这件物品？',
      content: '删除后会移入回收站，30 天内可以重新编辑并入库。',
      confirmText: '删除',
      confirmColor: '#A33F32',
    })
    if (!modal.confirm) return
    this.setData({ actionLoading: true })
    try {
      await deleteItem(item._id, item.version)
      this.setData({ actionLoading: false })
      this.closeMore()
      wx.showToast({ title: '已删除', icon: 'success' })
      void this.refreshOverview()
      void this.refresh(true, false)
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async remindItem(item: InventoryCardItem) {
    if (this.data.actionLoading) return
    if (item.expiryStatus === 'expired') {
      wx.showToast({ title: '已过期，无需提醒', icon: 'none' })
      this.closeMore()
      return
    }
    const accepted = await requestReminderAuthorization()
    this.closeMore()
    if (!accepted) return
    this.setData({ actionLoading: true })
    try {
      await armReminder(item._id)
      this.setData({ actionLoading: false })
      wx.showToast({ title: '提醒已开启', icon: 'success' })
    } catch (error) {
      this.handleActionError(error)
    }
  },

  handleActionError(error: unknown) {
    this.setData({ actionLoading: false })
    const message = getErrorMessage(error)
    wx.showToast({ title: message, icon: 'none', duration: 2500 })
    if (error instanceof CloudServiceError && error.code === 'CONFLICT') {
      void this.refresh(true, false)
    }
  },

  openBatchOperations() {
    if (!this.data.items.length) return
    const app = getApp<IAppOption>()
    app.globalData.pendingBatchIntent = {
      source: 'home',
      search: this.data.search,
      category: this.data.category,
      viewStatus: this.data.viewStatus,
    }
    wx.navigateTo({ url: '/pages/batch-operation/index?source=home' })
  },

  addItem() {
    wx.navigateTo({ url: '/pages/quick-entry/index' })
  },

  handleEmptyAction() {
    if (this.data.hasActiveConditions) this.resetFilters()
    else this.addItem()
  },

  retry() {
    void this.refreshOverview()
    void this.refresh(true, false)
  },

  retryLoadMore() {
    void this.refresh(false, false)
  },

  noop() {},
})
