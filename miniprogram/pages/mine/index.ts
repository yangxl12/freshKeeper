import { toInventoryCardItem } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import {
  listHistory,
  listTrash,
  permanentlyDeleteItem,
} from '../../services/inventory-service'
import { getSettings, updateSettings } from '../../services/settings-service'
import type { InventoryItem } from '../../types/inventory'

const REMINDER_DAY_OPTIONS = Array.from({ length: 31 }, (_, value) => ({
  value,
  label: value === 0 ? '到期当天' : `提前 ${value} 天`,
}))

let recordSearchTimer: number | undefined
let recordRequestSequence = 0

function decorateRecordItem(item: InventoryItem) {
  return {
    ...toInventoryCardItem(item),
    recordLabel: item.inventoryStatus === 'used_up' ? '已用完' : '已删除',
  }
}

Page({
  data: {
    settingsVisible: false,
    settingsLoading: true,
    settingsSaving: false,
    settingsError: '',
    reminderDayOptions: REMINDER_DAY_OPTIONS,
    reminderDayIndex: 1,
    savedReminderDayIndex: 1,
    hasReminderJobs: false,
    subscriptionMainSwitch: null as boolean | null,
    subscriptionSummary: '可在物品详情中逐件开启一次性提醒',
    recordMode: 'used_up' as 'used_up' | 'trash',
    recordLoading: true,
    recordLoadingMore: false,
    recordError: '',
    recordSearch: '',
    recordItems: [] as ReturnType<typeof decorateRecordItem>[],
    recordNextCursor: null as string | null,
  },

  onShow() {
    void this.loadSettings()
    void this.loadRecords(true)
    this.readSubscriptionSetting()
  },

  onUnload() {
    if (recordSearchTimer) clearTimeout(recordSearchTimer)
  },

  onPullDownRefresh() {
    Promise.all([this.loadSettings(), this.loadRecords(true)]).finally(() => {
      wx.stopPullDownRefresh()
    })
    this.readSubscriptionSetting()
  },

  onReachBottom() {
    if (this.data.recordNextCursor && !this.data.recordLoadingMore) void this.loadRecords(false)
  },

  async loadSettings() {
    this.setData({ settingsLoading: true, settingsError: '' })
    try {
      const settings = await getSettings()
      this.setData({
        reminderDayIndex: settings.defaultReminderLeadDays,
        savedReminderDayIndex: settings.defaultReminderLeadDays,
        hasReminderJobs: Boolean(settings.hasReminderJobs),
        settingsLoading: false,
      }, () => this.updateSubscriptionSummary())
    } catch (error) {
      this.setData({ settingsLoading: false, settingsError: getErrorMessage(error) })
    }
  },

  openSettings() {
    this.setData({
      settingsVisible: true,
      reminderDayIndex: this.data.savedReminderDayIndex,
      settingsError: '',
    })
  },

  closeSettings() {
    if (this.data.settingsSaving) return
    this.setData({
      settingsVisible: false,
      reminderDayIndex: this.data.savedReminderDayIndex,
      settingsError: '',
    })
  },

  stopPropagation() {},

  handleReminderDaysChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ reminderDayIndex: Number(event.detail.value) })
  },

  async saveSettings() {
    if (this.data.settingsSaving) return
    this.setData({ settingsSaving: true, settingsError: '' })
    try {
      const settings = await updateSettings({
        defaultReminderLeadDays: REMINDER_DAY_OPTIONS[this.data.reminderDayIndex].value,
      })
      this.setData({
        reminderDayIndex: settings.defaultReminderLeadDays,
        savedReminderDayIndex: settings.defaultReminderLeadDays,
        settingsSaving: false,
        settingsVisible: false,
      })
      wx.showToast({ title: '设置已保存', icon: 'success' })
    } catch (error) {
      this.setData({ settingsSaving: false, settingsError: getErrorMessage(error) })
    }
  },

  readSubscriptionSetting() {
    wx.getSetting({
      withSubscriptions: true,
      success: (result) => {
        const subscriptions = result.subscriptionsSetting
        this.setData(
          { subscriptionMainSwitch: subscriptions?.mainSwitch ?? null },
          () => this.updateSubscriptionSummary(),
        )
      },
    })
  },

  updateSubscriptionSummary() {
    let subscriptionSummary = this.data.hasReminderJobs
      ? '已有物品保存了提醒任务'
      : '可在物品详情中逐件开启一次性提醒'
    if (this.data.subscriptionMainSwitch === false) {
      subscriptionSummary = '微信通知总开关已关闭'
    } else if (this.data.subscriptionMainSwitch === true) {
      subscriptionSummary = this.data.hasReminderJobs
        ? '通知已开启，已有物品保存了提醒任务'
        : '通知已开启，每件物品仍需单独授权'
    }
    this.setData({ subscriptionSummary })
  },

  openNotificationSettings() {
    wx.openSetting({
      withSubscriptions: true,
      complete: () => this.readSubscriptionSetting(),
    })
  },

  async loadRecords(reset: boolean) {
    const requestSequence = ++recordRequestSequence
    if (reset) {
      this.setData({
        recordLoading: this.data.recordItems.length === 0,
        recordError: '',
        recordItems: [],
        recordNextCursor: null,
      })
    } else {
      this.setData({ recordLoadingMore: true })
    }

    try {
      const params = {
        search: this.data.recordSearch,
        cursor: reset ? null : this.data.recordNextCursor,
      }
      const result = this.data.recordMode === 'trash'
        ? await listTrash(params)
        : await listHistory({ ...params, status: 'used_up' })
      if (requestSequence !== recordRequestSequence) return
      const pageItems = result.items.map(decorateRecordItem)
      this.setData({
        recordItems: reset ? pageItems : [...this.data.recordItems, ...pageItems],
        recordNextCursor: result.nextCursor,
        recordLoading: false,
        recordLoadingMore: false,
        recordError: '',
      })
    } catch (error) {
      if (requestSequence !== recordRequestSequence) return
      this.setData({
        recordLoading: false,
        recordLoadingMore: false,
        recordError: getErrorMessage(error),
      })
    }
  },

  switchRecordMode(event: WechatMiniprogram.BaseEvent) {
    const recordMode = event.currentTarget.dataset.mode as 'used_up' | 'trash'
    if (recordMode === this.data.recordMode) return
    if (recordSearchTimer) clearTimeout(recordSearchTimer)
    this.setData({ recordMode, recordSearch: '', recordItems: [] }, () => void this.loadRecords(true))
  },

  handleRecordSearch(event: WechatMiniprogram.Input) {
    this.setData({ recordSearch: event.detail.value })
    if (recordSearchTimer) clearTimeout(recordSearchTimer)
    recordSearchTimer = setTimeout(() => void this.loadRecords(true), 300) as unknown as number
  },

  clearRecordSearch() {
    if (recordSearchTimer) clearTimeout(recordSearchTimer)
    this.setData({ recordSearch: '' }, () => void this.loadRecords(true))
  },

  openRecordItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  openTrashBatch() {
    const app = getApp<IAppOption>()
    app.globalData.pendingBatchIntent = { source: 'trash' }
    wx.navigateTo({ url: '/pages/batch-operation/index?source=trash' })
  },

  async deleteTrashItem(event: WechatMiniprogram.BaseEvent) {
    const itemId = String(event.currentTarget.dataset.id || '')
    const version = Number(event.currentTarget.dataset.version)
    const modal = await wx.showModal({
      title: '彻底删除这件物品？',
      content: '彻底删除后无法恢复。',
      confirmText: '彻底删除',
      confirmColor: '#A33F32',
    })
    if (!modal.confirm) return
    try {
      await permanentlyDeleteItem(itemId, version)
      wx.showToast({ title: '已彻底删除', icon: 'success' })
      void this.loadRecords(true)
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  retrySettings() {
    void this.loadSettings()
  },

  retryRecords() {
    void this.loadRecords(true)
  },
})
