import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  deleteItem,
  getItem,
  permanentlyDeleteItem,
} from '../../services/inventory-service'
import {
  armReminder,
  cancelReminder,
  requestReminderAuthorization,
} from '../../services/reminder-service'
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
            : '开启本次提醒',
    reminderActionDisabled: ['scheduled', 'sending', 'sent', 'unknown'].includes(
      reminderStatus || '',
    ),
    reminderStateText:
      reminderStatus === 'scheduled'
        ? '已开启'
        : reminderStatus === 'sent'
          ? '已发送'
          : reminderStatus
            ? '未开启'
            : '未开启',
  }
}

Page({
  data: {
    itemId: '',
    loading: true,
    actionLoading: false,
    errorMessage: '',
    item: null as ReturnType<typeof decorateItem> | null,
    reminderSheetVisible: false,
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

  restoreItem() {
    wx.navigateTo({ url: `/pages/item-form/index?id=${this.data.itemId}&restore=1` })
  },

  openReminder() {
    this.setData({ reminderSheetVisible: true })
  },

  closeReminder() {
    this.setData({ reminderSheetVisible: false })
  },

  async requestReminder() {
    const item = this.data.item
    if (!item || this.data.actionLoading || item.reminderActionDisabled) return
    if (item.expiryStatus === 'expired') {
      wx.showToast({ title: '已过期，无需提醒', icon: 'none' })
      return
    }
    const accepted = await requestReminderAuthorization()
    if (!accepted) return
    this.setData({ actionLoading: true })
    try {
      await armReminder(this.data.itemId)
      this.setData({ actionLoading: false })
      wx.showToast({ title: '提醒已开启', icon: 'success' })
      await this.loadItem()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async cancelReminder() {
    if (this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      await cancelReminder(this.data.itemId)
      this.setData({ actionLoading: false })
      wx.showToast({ title: '提醒已取消', icon: 'success' })
      await this.loadItem()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmComplete() {
    const result = await wx.showModal({
      title: '标记为已用完？',
      content: '物品会从当前库存移入已用完记录。',
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
      track('item_used_up')
      wx.showToast({ title: '已标记为用完', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmDelete() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    const result = await wx.showModal({
      title: '删除这件物品？',
      content: '删除后会移入回收站，30 天内可以重新编辑并入库。',
      confirmText: '删除',
      confirmColor: '#A33F32',
    })
    if (!result.confirm) return

    this.setData({ actionLoading: true })
    try {
      await deleteItem(item._id, item.version)
      wx.showToast({ title: '已删除', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async confirmPermanentDelete() {
    const item = this.data.item
    if (!item || this.data.actionLoading) return
    const result = await wx.showModal({
      title: '彻底删除这件物品？',
      content: '彻底删除后无法恢复。',
      confirmText: '彻底删除',
      confirmColor: '#A33F32',
    })
    if (!result.confirm) return

    this.setData({ actionLoading: true })
    try {
      await permanentlyDeleteItem(item._id, item.version)
      wx.showToast({ title: '已彻底删除', icon: 'success' })
      wx.navigateBack()
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

  noop() {},
})
