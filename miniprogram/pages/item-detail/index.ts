import { REMINDER_TEMPLATE_ID } from '../../config/runtime'
import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  decrementItem,
  deleteItem,
  discardItem,
  getItem,
} from '../../services/inventory-service'
import { armReminder, cancelReminder } from '../../services/reminder-service'
import type { InventoryItem, ReminderStatus } from '../../types/inventory'
import { track } from '../../utils/analytics'

const REMINDER_COPY: Record<Exclude<ReminderStatus, null>, string> = {
  scheduled: '本次提醒已开启，将在计划日期发送一次。',
  sending: '本次提醒正在发送，请勿重复开启。',
  sent: '本次临期提醒已经发送。',
  failed: '上次提醒未能发送，可重新授权开启。',
  unknown: '发送结果暂不确定，为避免重复提醒不再重试。',
  cancelled: '本次提醒已取消，可重新授权开启。',
}

function decorateItem(item: InventoryItem) {
  const shelfLifeText = item.shelfLifeValue
    ? `${item.shelfLifeValue}${
        item.shelfLifeUnit === 'day' ? '天' : item.shelfLifeUnit === 'month' ? '个月' : '年'
      }`
    : ''
  const reminderStatus = item.reminderStatus || null
  return {
    ...item,
    shelfLifeText,
    reminderStatus,
    reminderCopy: reminderStatus ? REMINDER_COPY[reminderStatus] : '尚未开启微信订阅提醒。',
    reminderActionText:
      reminderStatus === 'scheduled'
        ? '提醒已开启'
        : reminderStatus === 'sent'
          ? '提醒已发送'
          : reminderStatus === 'sending' || reminderStatus === 'unknown'
            ? '无需重复开启'
            : '开启本次临期提醒',
    reminderActionDisabled: ['scheduled', 'sending', 'sent', 'unknown'].includes(
      reminderStatus || '',
    ),
  }
}

Page({
  data: {
    itemId: '',
    loading: true,
    actionLoading: false,
    errorMessage: '',
    item: null as ReturnType<typeof decorateItem> | null,
  },

  onLoad(options: Record<string, string | undefined>) {
    const itemId = options.id || ''
    this.setData({ itemId })
    if (options.source === 'subscribe') track('reminder_open_detail')
  },

  onShow() {
    if (this.data.itemId) this.loadItem()
    else this.setData({ loading: false, errorMessage: '缺少物品编号，无法查看详情' })
  },

  async loadItem() {
    this.setData({ loading: !this.data.item, errorMessage: '' })
    try {
      const item = await getItem(this.data.itemId)
      this.setData({ item: decorateItem(item), loading: false })
      wx.setNavigationBarTitle({ title: item.name })
    } catch (error) {
      this.setData({ loading: false, errorMessage: getErrorMessage(error) })
    }
  },

  editItem() {
    wx.navigateTo({ url: `/pages/item-form/index?id=${this.data.itemId}` })
  },

  async decrement() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    if (item.quantity === 1) {
      const result = await wx.showModal({
        title: '这已经是最后一件',
        content: '数量减为 0 后，将直接标记为已用完。',
        confirmText: '标记用完',
        confirmColor: '#245B49',
      })
      if (result.confirm) await this.complete()
      return
    }

    this.setData({ actionLoading: true })
    try {
      const result = await decrementItem(item._id, item.version)
      getApp<IAppOption>().globalData.inventoryDirty = true
      this.setData({
        'item.quantity': result.quantity,
        'item.version': result.version,
        actionLoading: false,
      })
      wx.showToast({ title: '数量已减一', icon: 'success' })
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmComplete() {
    const result = await wx.showModal({
      title: '标记为已用完？',
      content: '物品会从当前库存移入历史记录。',
      confirmText: '已用完',
      confirmColor: '#245B49',
    })
    if (result.confirm) await this.complete()
  },

  async complete() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      await completeItem(item._id, item.version)
      getApp<IAppOption>().globalData.inventoryDirty = true
      track('item_used_up')
      wx.showToast({ title: '已移入历史', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmDiscard() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    const result = await wx.showModal({
      title: '标记为已丢弃？',
      content: '这条记录会移入历史，并保留当前数量。',
      confirmText: '确认丢弃',
      confirmColor: '#A33F32',
    })
    if (!result.confirm) return

    this.setData({ actionLoading: true })
    try {
      await discardItem(item._id, item.version)
      getApp<IAppOption>().globalData.inventoryDirty = true
      track('item_discarded')
      wx.showToast({ title: '已移入历史', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmDelete() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    const result = await wx.showModal({
      title: '删除这条误录记录？',
      content: '删除后无法恢复；用完或丢弃请使用上方处理操作。',
      confirmText: '删除',
      confirmColor: '#A33F32',
    })
    if (!result.confirm) return

    this.setData({ actionLoading: true })
    try {
      await deleteItem(item._id, item.version)
      getApp<IAppOption>().globalData.inventoryDirty = true
      wx.showToast({ title: '已删除', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  requestReminder() {
    const item = this.data.item
    if (!item || this.data.actionLoading || item.reminderActionDisabled) return
    if (!REMINDER_TEMPLATE_ID) {
      wx.showModal({
        title: '提醒功能尚未配置',
        content: '请先在运行配置中填写微信一次性订阅消息模板 ID。',
        showCancel: false,
      })
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [REMINDER_TEMPLATE_ID],
      success: (result) => {
        const status = result[REMINDER_TEMPLATE_ID]
        track('reminder_request_result', { result: status || 'unknown' })
        if (status === 'accept') this.registerReminder()
        else {
          wx.showToast({ title: '提醒未开启', icon: 'none' })
        }
      },
      fail: () => {
        track('reminder_request_result', { result: 'failed' })
        wx.showToast({ title: '提醒未开启，可稍后再试', icon: 'none' })
      },
    })
  },

  async registerReminder() {
    this.setData({ actionLoading: true })
    try {
      const result = await armReminder(this.data.itemId)
      wx.showToast({ title: '提醒已开启', icon: 'success' })
      this.setData({ actionLoading: false })
      await this.loadItem()
      return result
    } catch (error) {
      this.handleActionError(error)
      return null
    }
  },

  async cancelReminder() {
    if (this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      await cancelReminder(this.data.itemId)
      wx.showToast({ title: '提醒已取消', icon: 'success' })
      this.setData({ actionLoading: false })
      await this.loadItem()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  handleActionError(error: unknown) {
    this.setData({ actionLoading: false })
    const message = getErrorMessage(error)
    wx.showToast({ title: message, icon: 'none', duration: 2500 })
    if (error instanceof CloudServiceError && error.code === 'CONFLICT') this.loadItem()
  },

  retry() {
    this.loadItem()
  },

  backHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})
