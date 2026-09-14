import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  deleteItem,
  getItem,
  permanentlyDeleteItem,
} from '../../services/inventory-service'
import { resolveReminderTime } from '../../domain/reminder-time'
import { armReminder, requestReminderAuthorization } from '../../services/reminder-service'
import type { InventoryItem } from '../../types/inventory'
import { track } from '../../utils/analytics'

/**
 * 把物品折算成「微信提醒时间 + 一句状态」。
 *
 * 提醒时间完全由「到期日期 - 提前天数（到点 09:30）」推出来，不落库、不可编辑。
 * 微信一次性订阅的事实：额度用完就结束，所以已推送/推送中不再给任何操作入口，
 * 也没有「取消提醒」——取消的语义已经被「删物品 / 标记已用完」覆盖。任务为空、
 * 失败或已停止时则允许原地补开，避免老物品和偶发建任务失败只能显示死状态。
 */
function decorateItem(item: InventoryItem) {
  const shelfLifeText = item.shelfLifeValue
    ? `${item.shelfLifeValue}${
        item.shelfLifeUnit === 'day' ? '天' : item.shelfLifeUnit === 'month' ? '个月' : '年'
      }`
    : ''
  const reminder = resolveReminderTime({
    expiryDate: item.expiryDate,
    reminderLeadDays: item.reminderLeadDays,
  })
  const reminderStatus = item.reminderStatus || null

  let reminderAtNote = ''
  if (!reminder) reminderAtNote = ''
  else if (item.inventoryStatus !== 'active') reminderAtNote = '微信服务通知已停止'
  else if (reminderStatus === 'sent') reminderAtNote = '微信服务通知已发送'
  else if (reminderStatus === 'sending') reminderAtNote = '微信服务通知发送中'
  else if (reminderStatus === 'failed') reminderAtNote = '微信服务通知发送失败'
  else if (reminderStatus === 'unknown') reminderAtNote = '微信通知结果待确认，不会自动重发'
  else if (reminder.missed) reminderAtNote = '提醒时间已过，不再发送'
  else if (reminderStatus === 'scheduled') reminderAtNote = '届时发送微信服务通知'
  else if (reminderStatus === 'cancelled') reminderAtNote = '微信服务通知已停止'
  else reminderAtNote = '本次微信服务通知尚未开启'

  const canEnableReminder = Boolean(
    reminder &&
    !reminder.missed &&
    item.inventoryStatus === 'active' &&
    (!reminderStatus || reminderStatus === 'failed' || reminderStatus === 'cancelled'),
  )

  return {
    ...item,
    shelfLifeText,
    reminderAtText: reminder?.text || '',
    reminderAtNote,
    canEnableReminder,
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

  /**
   * 为没有有效任务的物品补开一次微信服务通知。
   * requestSubscribeMessage 必须由用户点击触发，不能在 onShow 里偷偷自动申请。
   */
  async enableReminder() {
    const item = this.data.item
    if (!item?.canEnableReminder || this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      const accepted = await requestReminderAuthorization()
      if (!accepted) {
        this.setData({ actionLoading: false })
        return
      }
      const result = await armReminder(item._id)
      await this.loadItem()
      this.setData({ actionLoading: false })
      wx.showToast({
        title: result.status === 'missed' ? '提醒时间已过' : '微信提醒已开启',
        icon: result.status === 'missed' ? 'none' : 'success',
      })
    } catch (error) {
      this.setData({ actionLoading: false })
      wx.showToast({ title: getErrorMessage(error), icon: 'none', duration: 2500 })
    }
  },

  editItem() {
    wx.navigateTo({ url: `/pages/item-form/index?id=${this.data.itemId}` })
  },

  restoreItem() {
    wx.navigateTo({ url: `/pages/item-form/index?id=${this.data.itemId}&restore=1` })
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
})
