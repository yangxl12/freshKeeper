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
import type { InventoryItem } from '../../types/inventory'
import { track } from '../../utils/analytics'
import { addDays, parseDateKey } from '../../utils/date-key'

/** 能重新开启的状态，与云端 reminderApi/rules.js:canArmReminder 保持一致。 */
const ARMABLE_STATUSES = ['failed', 'cancelled']

function formatMonthDay(value: string): string {
  const parts = parseDateKey(value)
  return parts ? `${parts.month} 月 ${parts.day} 日` : value
}

/**
 * 把提醒任务折算成「一句状态 + 一句说明 + 能不能点」。
 *
 * 微信一次性订阅的事实：一次授权换一条额度，发出去就结束。所以终态
 * （sending / sent / unknown）不提供任何按钮，也不承诺「还能再开一次」。
 * 发送日期按「到期日 - 提前天数」本地换算：保存时云端会同步 remindDate，
 * 派发时对不上的任务直接作废，所以真能发出去的任务日期必然等于这个值。
 */
function decorateItem(item: InventoryItem) {
  const shelfLifeText = item.shelfLifeValue
    ? `${item.shelfLifeValue}${
        item.shelfLifeUnit === 'day' ? '天' : item.shelfLifeUnit === 'month' ? '个月' : '年'
      }`
    : ''
  const reminderStatus = item.reminderStatus || null
  const expired = item.expiryStatus === 'expired'
  let sendDateText = ''
  try {
    sendDateText = formatMonthDay(addDays(item.expiryDate, -item.reminderLeadDays))
  } catch (_error) {
    sendDateText = ''
  }
  const sendDateClause = sendDateText ? `将在 ${sendDateText}` : '将在提醒日'

  let reminderStateText = '未开启'
  let reminderCopy = sendDateText
    ? `开启后 ${sendDateText} 推送一条微信提醒，只发一次。`
    : '开启后会在提醒日推送一条微信提醒，只发一次。'
  if (expired) {
    reminderStateText = '已过期'
    reminderCopy = '这件物品已经过期，不再发送提醒。'
  } else if (reminderStatus === 'scheduled') {
    reminderStateText = sendDateText ? `已预约 · ${sendDateText}` : '已预约'
    reminderCopy = `提醒${sendDateClause}推送一条微信消息，只发一次。`
  } else if (reminderStatus === 'sending') {
    reminderStateText = '正在发送'
    reminderCopy = '提醒正在推送，请勿重复开启。'
  } else if (reminderStatus === 'sent') {
    reminderStateText = '已发送'
    reminderCopy = '这次提醒已经发送。一次性提醒发完即结束。'
  } else if (reminderStatus === 'unknown') {
    reminderStateText = '结果未确定'
    reminderCopy = '上次发送结果未确定，为避免重复推送不再重试。'
  } else if (reminderStatus === 'failed') {
    reminderStateText = '发送失败'
    reminderCopy = '上次提醒没能发出去，可以重新开启一次。'
  } else if (reminderStatus === 'cancelled') {
    reminderStateText = '已取消'
    reminderCopy = '提醒已取消，可以重新开启一次。'
  }

  return {
    ...item,
    shelfLifeText,
    reminderStatus,
    reminderSendDateText: sendDateText,
    reminderStateText,
    reminderCopy,
    reminderArmText: reminderStatus ? '重新开启提醒' : '开启到期提醒',
    canArmReminder:
      !expired &&
      item.inventoryStatus === 'active' &&
      (!reminderStatus || ARMABLE_STATUSES.includes(reminderStatus)),
    canCancelReminder: reminderStatus === 'scheduled',
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
    if (!item || this.data.actionLoading || !item.canArmReminder) return
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
    if (this.data.actionLoading || !this.data.item?.canCancelReminder) return
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
