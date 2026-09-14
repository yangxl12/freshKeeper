import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  deleteItem,
  getItem,
  onItemCoverReady,
  permanentlyDeleteItem,
} from '../../services/inventory-service'
import { coverThumbUrl } from '../../domain/inventory'
import { resolveReminderTime } from '../../domain/reminder-time'
import type { InventoryItem } from '../../types/inventory'
import { track } from '../../utils/analytics'

// 无封面（或封面加载失败）时的兜底图，与首页卡片同源。
const COVER_PLACEHOLDER = '/assets/inventory-placeholder.svg'

/**
 * 把物品折算成「微信提醒时间 + 一句状态」。
 *
 * 提醒时间完全由「到期日期 - 提前天数（到点 09:30）」推出来，不落库、不可编辑。
 * 有效在库物品默认启用微信提醒，正常待发送状态无需再显示一个技术状态或操作入口；
 * 只有已发送、失败、结果未知、时间已过等异常或终态才补充说明。
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
  else if (reminderStatus === 'cancelled') reminderAtNote = '微信服务通知已停止'
  else reminderAtNote = ''

  return {
    ...item,
    shelfLifeText,
    reminderAtText: reminder?.text || '',
    reminderAtNote,
    // 与首页卡片复用同一个派生函数：将来恢复缩略图参数时两处一起变，不会一个有大图一个没有。
    coverUrl: coverThumbUrl(item.coverFileId),
  }
}

Page({
  data: {
    itemId: '',
    loading: true,
    actionLoading: false,
    errorMessage: '',
    item: null as ReturnType<typeof decorateItem> | null,
    coverPlaceholder: COVER_PLACEHOLDER,
    // 封面加载失败 → 回退占位图，同一张封面不反复重试。
    coverFailed: false,
    // 图片解码完成才淡入，避免从占位图切到真图时"跳"一下。
    coverLoaded: false,
  },

  // 封面就绪广播的退订句柄。挂在页面实例上而不是模块级：详情页可能被 navigateTo 叠多层，
  // 每个实例各自持有自己的订阅，不会互相覆盖掉对方的退订。
  coverUnsubscribe: null as (() => void) | null,

  onLoad(options: Record<string, string | undefined>) {
    const itemId = options.id || ''
    this.setData({ itemId })
    if (options.source === 'subscribe') track('reminder_open_detail')
  },

  onShow() {
    this.subscribeCoverUpdates()
    if (this.data.itemId) this.loadItem()
    else this.setData({ loading: false, errorMessage: '缺少物品编号，无法查看详情' })
  },

  onHide() {
    this.unsubscribeCoverUpdates()
  },

  onUnload() {
    this.unsubscribeCoverUpdates()
  },

  // 封面是保存后后台生成的：用户进详情页时图可能还没就绪，等生成完直接补到当前页面上。
  // 与首页 subscribeCoverUpdates 同一套机制，区别是这里只认自己这一件物品。
  subscribeCoverUpdates() {
    if (this.coverUnsubscribe) return
    this.coverUnsubscribe = onItemCoverReady(({ itemId, coverFileId }) => {
      const item = this.data.item
      if (!item || item._id !== itemId) return
      this.setData({
        item: { ...item, coverFileId, coverUrl: coverThumbUrl(coverFileId) },
        coverFailed: false,
        coverLoaded: false,
      })
    })
  },

  unsubscribeCoverUpdates() {
    if (!this.coverUnsubscribe) return
    this.coverUnsubscribe()
    this.coverUnsubscribe = null
  },

  async loadItem() {
    this.setData({ loading: !this.data.item, errorMessage: '' })
    try {
      const item = await getItem(this.data.itemId)
      this.setData({
        item: decorateItem(item),
        loading: false,
        coverFailed: false,
        coverLoaded: false,
      })
      wx.setNavigationBarTitle({ title: item.name })
    } catch (error) {
      this.setData({ loading: false, errorMessage: getErrorMessage(error) })
    }
  },

  handleCoverLoad() {
    if (this.data.coverLoaded) return
    this.setData({ coverLoaded: true })
  },

  handleCoverError() {
    if (this.data.coverFailed) return
    this.setData({ coverFailed: true })
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
