import { CATEGORY_OPTIONS, STORAGE_OPTIONS, groupInventoryItems } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { listActive } from '../../services/inventory-service'
import type { InventoryItem } from '../../types/inventory'

let searchTimer: number | undefined
let midnightTimer: number | undefined
let listRequestSequence = 0
const MILLIS_PER_DAY = 86_400_000
const SHANGHAI_OFFSET_MILLIS = 8 * 60 * 60 * 1000

function millisecondsUntilShanghaiTomorrow(): number {
  const shanghaiNow = Date.now() + SHANGHAI_OFFSET_MILLIS
  const nextDay = (Math.floor(shanghaiNow / MILLIS_PER_DAY) + 1) * MILLIS_PER_DAY
  return nextDay - shanghaiNow + 1000
}

function decorateItem(item: InventoryItem) {
  const [, month, day] = item.expiryDate.split('-')
  return {
    ...item,
    expiryMonth: `${month}月`,
    expiryDay: day,
  }
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    errorMessage: '',
    items: [] as ReturnType<typeof decorateItem>[],
    groups: [] as Array<{
      key: string
      label: string
      tone: string
      items: ReturnType<typeof decorateItem>[]
    }>,
    overview: {
      expired: 0,
      expiringWithin7Days: 0,
      activeTotal: 0,
    },
    serverToday: '',
    search: '',
    categoryOptions: CATEGORY_OPTIONS,
    storageOptions: STORAGE_OPTIONS,
    categoryIndex: 0,
    storageIndex: 0,
    nextCursor: null as string | null,
    isFiltered: false,
  },

  onShow() {
    const app = getApp<IAppOption>()
    app.globalData.inventoryDirty = false
    void this.refresh(true)
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
    this.refresh(true).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.nextCursor && !this.data.loadingMore) this.refresh(false)
  },

  scheduleMidnightRefresh() {
    if (midnightTimer) clearTimeout(midnightTimer)
    midnightTimer = setTimeout(() => {
      void this.refresh(true)
      this.scheduleMidnightRefresh()
    }, millisecondsUntilShanghaiTomorrow()) as unknown as number
  },

  async refresh(reset: boolean) {
    const requestSequence = ++listRequestSequence
    if (reset) {
      this.setData({ loading: this.data.items.length === 0, errorMessage: '' })
    } else {
      this.setData({ loadingMore: true })
    }

    const category = CATEGORY_OPTIONS[this.data.categoryIndex]?.value || ''
    const storageLocation = STORAGE_OPTIONS[this.data.storageIndex]?.value || ''

    try {
      const result = await listActive({
        search: this.data.search,
        category,
        storageLocation,
        cursor: reset ? null : this.data.nextCursor,
      })
      if (requestSequence !== listRequestSequence) return
      const pageItems = result.items.map(decorateItem)
      const items = reset ? pageItems : [...this.data.items, ...pageItems]
      this.setData({
        items,
        groups: groupInventoryItems(items),
        overview: result.overview,
        serverToday: result.serverToday,
        nextCursor: result.nextCursor,
        loading: false,
        loadingMore: false,
        errorMessage: '',
        isFiltered: Boolean(this.data.search.trim() || category || storageLocation),
      })
    } catch (error) {
      if (requestSequence !== listRequestSequence) return
      const message = getErrorMessage(error)
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: this.data.items.length ? `库存未更新：${message}` : message,
      })
    }
  },

  handleSearchInput(event: WechatMiniprogram.Input) {
    const search = event.detail.value
    this.setData({ search })
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => this.refresh(true), 300) as unknown as number
  },

  clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    this.setData({ search: '' }, () => this.refresh(true))
  },

  handleCategoryChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(event.detail.value) }, () => this.refresh(true))
  },

  handleStorageChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ storageIndex: Number(event.detail.value) }, () => this.refresh(true))
  },

  resetFilters() {
    this.setData(
      { search: '', categoryIndex: 0, storageIndex: 0 },
      () => this.refresh(true),
    )
  },

  openItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  addItem() {
    wx.navigateTo({ url: '/pages/item-form/index' })
  },

  handleEmptyAction() {
    if (this.data.isFiltered) this.resetFilters()
    else this.addItem()
  },

  retry() {
    this.refresh(true)
  },
})
