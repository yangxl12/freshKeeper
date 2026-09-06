import { HISTORY_STATUS_OPTIONS, STORAGE_OPTIONS } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { listHistory } from '../../services/inventory-service'
import { getSettings, updateSettings } from '../../services/settings-service'
import type { InventoryItem, InventoryStatus, StorageLocation } from '../../types/inventory'

const REMINDER_DAY_OPTIONS = Array.from({ length: 31 }, (_, value) => ({
  value,
  label: value === 0 ? '到期当天' : `提前 ${value} 天`,
}))
const DEFAULT_STORAGE_OPTIONS: ReadonlyArray<{
  value: StorageLocation | null
  label: string
}> = [
  { value: null, label: '未设置' },
  ...STORAGE_OPTIONS.slice(1).map((option) => ({
    value: option.value as StorageLocation,
    label: option.label,
  })),
]

let historySearchTimer: number | undefined
let historyRequestSequence = 0

function decorateHistoryItem(item: InventoryItem) {
  const [, month, day] = item.expiryDate.split('-')
  return {
    ...item,
    expiryMonth: `${month}月`,
    expiryDay: day,
    inventoryStatusLabel: item.inventoryStatus === 'used_up' ? '已用完' : '已丢弃',
  }
}

Page({
  data: {
    settingsLoading: true,
    settingsSaving: false,
    settingsError: '',
    reminderDayOptions: REMINDER_DAY_OPTIONS,
    reminderDayIndex: 3,
    savedReminderDayIndex: 3,
    storageOptions: DEFAULT_STORAGE_OPTIONS,
    storageIndex: 0,
    savedStorageIndex: 0,
    hasReminderJobs: false,
    subscriptionMainSwitch: null as boolean | null,
    subscriptionSummary: '可在物品详情中逐件开启一次性提醒',
    historyLoading: true,
    historyLoadingMore: false,
    historyError: '',
    historySearch: '',
    historyStatusOptions: HISTORY_STATUS_OPTIONS,
    historyStatusIndex: 0,
    historyItems: [] as ReturnType<typeof decorateHistoryItem>[],
    historyNextCursor: null as string | null,
  },

  onShow() {
    this.loadSettings()
    this.loadHistory(true)
    this.readSubscriptionSetting()
  },

  onUnload() {
    if (historySearchTimer) clearTimeout(historySearchTimer)
  },

  onPullDownRefresh() {
    Promise.all([this.loadSettings(), this.loadHistory(true)]).finally(() => {
      wx.stopPullDownRefresh()
    })
    this.readSubscriptionSetting()
  },

  onReachBottom() {
    if (this.data.historyNextCursor && !this.data.historyLoadingMore) {
      this.loadHistory(false)
    }
  },

  async loadSettings() {
    this.setData({ settingsLoading: true, settingsError: '' })
    try {
      const settings = await getSettings()
      const storageIndex = DEFAULT_STORAGE_OPTIONS.findIndex(
        (option) => option.value === settings.defaultStorageLocation,
      )
      this.setData({
        reminderDayIndex: settings.defaultReminderLeadDays,
        savedReminderDayIndex: settings.defaultReminderLeadDays,
        storageIndex: storageIndex >= 0 ? storageIndex : 0,
        savedStorageIndex: storageIndex >= 0 ? storageIndex : 0,
        hasReminderJobs: Boolean(settings.hasReminderJobs),
        settingsLoading: false,
      }, () => this.updateSubscriptionSummary())
    } catch (error) {
      this.setData({ settingsLoading: false, settingsError: getErrorMessage(error) })
    }
  },

  async saveSettings(nextReminderDayIndex: number, nextStorageIndex: number) {
    if (this.data.settingsSaving) return
    this.setData({ settingsSaving: true, settingsError: '' })
    try {
      const settings = await updateSettings({
        defaultReminderLeadDays: REMINDER_DAY_OPTIONS[nextReminderDayIndex].value,
        defaultStorageLocation: DEFAULT_STORAGE_OPTIONS[nextStorageIndex].value,
      })
      const storageIndex = DEFAULT_STORAGE_OPTIONS.findIndex(
        (option) => option.value === settings.defaultStorageLocation,
      )
      this.setData({
        reminderDayIndex: settings.defaultReminderLeadDays,
        savedReminderDayIndex: settings.defaultReminderLeadDays,
        storageIndex: storageIndex >= 0 ? storageIndex : 0,
        savedStorageIndex: storageIndex >= 0 ? storageIndex : 0,
        settingsSaving: false,
      })
      wx.showToast({ title: '默认设置已保存', icon: 'success' })
    } catch (error) {
      this.setData({
        reminderDayIndex: this.data.savedReminderDayIndex,
        storageIndex: this.data.savedStorageIndex,
        settingsSaving: false,
        settingsError: getErrorMessage(error),
      })
    }
  },

  handleReminderDaysChange(event: WechatMiniprogram.PickerChange) {
    const reminderDayIndex = Number(event.detail.value)
    this.setData({ reminderDayIndex })
    this.saveSettings(reminderDayIndex, this.data.storageIndex)
  },

  handleStorageChange(event: WechatMiniprogram.PickerChange) {
    const storageIndex = Number(event.detail.value)
    this.setData({ storageIndex })
    this.saveSettings(this.data.reminderDayIndex, storageIndex)
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
      ? '已有物品保存了提醒任务；一次性发送额度以微信平台为准'
      : '可在物品详情中逐件开启一次性提醒'
    if (this.data.subscriptionMainSwitch === false) {
      subscriptionSummary = '微信通知总开关已关闭，请到设置中开启'
    } else if (this.data.subscriptionMainSwitch === true) {
      subscriptionSummary = this.data.hasReminderJobs
        ? '通知总开关已开启，已有物品保存了提醒任务'
        : '通知总开关已开启；每件物品仍需单独授权'
    }
    this.setData({ subscriptionSummary })
  },

  openNotificationSettings() {
    wx.openSetting({
      withSubscriptions: true,
      complete: () => this.readSubscriptionSetting(),
    })
  },

  async loadHistory(reset: boolean) {
    const requestSequence = ++historyRequestSequence
    if (reset) this.setData({ historyLoading: this.data.historyItems.length === 0, historyError: '' })
    else this.setData({ historyLoadingMore: true })

    const status = HISTORY_STATUS_OPTIONS[this.data.historyStatusIndex]
      ?.value as InventoryStatus | ''
    try {
      const result = await listHistory({
        search: this.data.historySearch,
        status,
        cursor: reset ? null : this.data.historyNextCursor,
      })
      if (requestSequence !== historyRequestSequence) return
      const pageItems = result.items.map(decorateHistoryItem)
      this.setData({
        historyItems: reset ? pageItems : [...this.data.historyItems, ...pageItems],
        historyNextCursor: result.nextCursor,
        historyLoading: false,
        historyLoadingMore: false,
        historyError: '',
      })
    } catch (error) {
      if (requestSequence !== historyRequestSequence) return
      const message = getErrorMessage(error)
      this.setData({
        historyLoading: false,
        historyLoadingMore: false,
        historyError: this.data.historyItems.length ? `历史未更新：${message}` : message,
      })
    }
  },

  handleHistorySearch(event: WechatMiniprogram.Input) {
    this.setData({ historySearch: event.detail.value })
    if (historySearchTimer) clearTimeout(historySearchTimer)
    historySearchTimer = setTimeout(() => this.loadHistory(true), 300) as unknown as number
  },

  clearHistorySearch() {
    if (historySearchTimer) clearTimeout(historySearchTimer)
    this.setData({ historySearch: '' }, () => this.loadHistory(true))
  },

  handleHistoryStatus(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ historyStatusIndex: index }, () => this.loadHistory(true))
  },

  openHistoryItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  retrySettings() {
    this.loadSettings()
  },

  retryHistory() {
    this.loadHistory(true)
  },
})
