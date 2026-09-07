import { getErrorMessage } from '../../services/cloud-client'
import { getOverview, listInventory } from '../../services/inventory-service'
import {
  HOME_CARD_VIEW_STATUS,
  toInventoryCardItem,
  type InventoryCardItem,
} from '../../domain/inventory'
import type { InventoryOverviewResult } from '../../types/inventory'
import { millisecondsUntilShanghaiTomorrow } from '../../utils/shanghai-time'

let midnightTimer: number | undefined
let overviewRequestSequence = 0

Page({
  data: {
    loading: true,
    refreshing: false,
    errorMessage: '',
    overview: null as InventoryOverviewResult | null,
    expiringItems: [] as InventoryCardItem[],
  },

  onShow() {
    void this.refresh()
    this.scheduleMidnightRefresh()
  },

  onHide() {
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  onUnload() {
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  onPullDownRefresh() {
    this.setData({ refreshing: true })
    this.refresh().finally(() => {
      this.setData({ refreshing: false })
      wx.stopPullDownRefresh()
    })
  },

  scheduleMidnightRefresh() {
    if (midnightTimer) clearTimeout(midnightTimer)
    midnightTimer = setTimeout(() => {
      void this.refresh()
      this.scheduleMidnightRefresh()
    }, millisecondsUntilShanghaiTomorrow()) as unknown as number
  },

  async refresh() {
    const requestSequence = ++overviewRequestSequence
    this.setData({ loading: !this.data.overview, errorMessage: '' })
    try {
      const [overview, expiringResult] = await Promise.all([
        getOverview(),
        listInventory({ viewStatus: 'expiring' }),
      ])
      if (requestSequence !== overviewRequestSequence) return
      this.setData({
        overview,
        expiringItems: expiringResult.items.map(toInventoryCardItem),
        loading: false,
        errorMessage: '',
      })
    } catch (error) {
      if (requestSequence !== overviewRequestSequence) return
      const message = getErrorMessage(error)
      this.setData({
        loading: false,
        errorMessage: this.data.overview ? `概览未更新：${message}` : message,
      })
    }
  },

  openInventory(event: WechatMiniprogram.CustomEvent) {
    const card = event.currentTarget.dataset.card as keyof typeof HOME_CARD_VIEW_STATUS
    const viewStatus = HOME_CARD_VIEW_STATUS[card]
    if (!viewStatus) return
    const app = getApp<IAppOption>()
    const intent = { viewStatus, source: 'home_card' as const }
    app.globalData.pendingInventoryIntent = intent
    wx.switchTab({
      url: '/pages/inventory/index',
      fail: () => {
        if (app.globalData.pendingInventoryIntent === intent) {
          app.globalData.pendingInventoryIntent = null
        }
        wx.showToast({ title: '暂时无法打开库存', icon: 'none' })
      },
    })
  },

  addItem() {
    wx.navigateTo({ url: '/pages/item-form/index' })
  },

  openBatchOperations() {
    const app = getApp<IAppOption>()
    app.globalData.pendingBatchIntent = { source: 'home', viewStatus: 'expiring' }
    wx.navigateTo({ url: '/pages/batch-operation/index?source=home' })
  },

  openItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  retry() {
    void this.refresh()
  },
})
