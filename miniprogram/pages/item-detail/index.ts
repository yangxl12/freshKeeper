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
import { armReminder, requestReminderAuthorization } from '../../services/reminder-service'
import type { InventoryItem } from '../../types/inventory'
import { track } from '../../utils/analytics'

// 无封面（或封面加载失败）时的兜底图，与首页卡片同源。
const COVER_PLACEHOLDER = '/assets/inventory-placeholder.svg'

/**
 * 封面区状态机。用一个状态取代原来的 coverLoaded / coverFailed 两个布尔，
 * 避免出现"已就绪又被打回加载中"这类互相矛盾的中间态（那种中间态正是闪动的来源）。
 *
 * idle    没有封面，只显示占位图
 * loading 真图解码中：占位图 + 转圈
 * ready   真图已解码，淡入盖在占位图之上
 * failed  真图加载失败：退回占位图，同一张图不反复重试
 */
type CoverStatus = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * 真图解码的兜底窗口。
 *
 * `<image>` 的 bindload 在微信里是可靠的，但真出现不触发的情况时，转圈会一直转下去。
 * 超过这个时间还没等到回调就当作已完成 —— 底下常驻的占位图会顶上来，
 * 用户看到的是"图没出来"，而不是"永远在转"。
 */
const COVER_REVEAL_FALLBACK_MS = 2500

/**
 * 把物品折算成「微信提醒时间 + 一句状态」。
 *
 * 提醒时间完全由「到期日期 - 提前天数（到点 16:00）」推出来，不落库、不可编辑。
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
  const canEnableReminder = Boolean(
    reminder
      && !reminder.missed
      && item.inventoryStatus === 'active'
      && (reminderStatus === null || reminderStatus === 'failed' || reminderStatus === 'cancelled'),
  )

  let reminderAtNote = ''
  if (!reminder) reminderAtNote = ''
  else if (item.inventoryStatus !== 'active') reminderAtNote = '微信服务通知已停止'
  else if (reminderStatus === 'sent') reminderAtNote = '微信服务通知已发送'
  else if (reminderStatus === 'sending') reminderAtNote = '微信服务通知发送中'
  else if (reminderStatus === 'failed') reminderAtNote = '微信服务通知发送失败'
  else if (reminderStatus === 'unknown') reminderAtNote = '微信通知结果待确认，不会自动重发'
  else if (reminder.missed) reminderAtNote = '提醒时间已过，不再发送'
  else if (reminderStatus === 'cancelled') reminderAtNote = '微信服务通知已停止'
  else if (reminderStatus === null) reminderAtNote = '微信提醒未开启'
  else reminderAtNote = ''

  return {
    ...item,
    shelfLifeText,
    reminderAtText: reminder?.text || '',
    reminderAtNote,
    canEnableReminder,
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
    // 封面区状态，取值含义见 CoverStatus。
    coverStatus: 'idle' as CoverStatus,
  },

  // 封面就绪广播的退订句柄。挂在页面实例上而不是模块级：详情页可能被 navigateTo 叠多层，
  // 每个实例各自持有自己的订阅，不会互相覆盖掉对方的退订。
  coverUnsubscribe: null as (() => void) | null,

  // 真图解码的兜底定时器。onUnload 必须清掉，不让回调落在已经销毁的页面上。
  coverFallbackTimer: null as ReturnType<typeof setTimeout> | null,

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
    this.clearCoverFallback()
  },

  // 真图开始加载时挂一个兜底，防止 bindload 永不触发导致转圈停不下来。
  scheduleCoverFallback() {
    this.clearCoverFallback()
    this.coverFallbackTimer = setTimeout(() => {
      this.coverFallbackTimer = null
      if (this.data.coverStatus !== 'loading') return
      this.setData({ coverStatus: 'ready' })
    }, COVER_REVEAL_FALLBACK_MS)
  },

  clearCoverFallback() {
    if (!this.coverFallbackTimer) return
    clearTimeout(this.coverFallbackTimer)
    this.coverFallbackTimer = null
  },

  // 封面是保存后后台生成的：用户进详情页时图可能还没就绪，等生成完直接补到当前页面上。
  // 与首页 subscribeCoverUpdates 同一套机制，区别是这里只认自己这一件物品。
  subscribeCoverUpdates() {
    if (this.coverUnsubscribe) return
    this.coverUnsubscribe = onItemCoverReady(({ itemId, coverFileId }) => {
      const item = this.data.item
      if (!item || item._id !== itemId) return
      const coverUrl = coverThumbUrl(coverFileId)
      // 已经是同一张图就别写 data：无意义的 setData 会让 <image> 白走一遍加载。
      if (coverUrl === item.coverUrl) return
      this.setData({
        item: { ...item, coverFileId, coverUrl },
        coverStatus: coverUrl ? 'loading' : 'idle',
      })
      if (coverUrl) this.scheduleCoverFallback()
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
      const decorated = decorateItem(item)
      // 从编辑页返回会重跑一次 loadItem：封面没变就保持原状态不动，
      // 否则已经显示好的图会被拉回透明、重播一遍淡入 —— 那正是要修掉的"闪一下"。
      const previousCoverUrl = this.data.item ? this.data.item.coverUrl : ''
      const coverChanged = decorated.coverUrl !== previousCoverUrl
      const coverStatus: CoverStatus = coverChanged
        ? decorated.coverUrl
          ? 'loading'
          : 'idle'
        : this.data.coverStatus
      this.setData({ item: decorated, loading: false, coverStatus })
      if (coverChanged && decorated.coverUrl) this.scheduleCoverFallback()
      wx.setNavigationBarTitle({ title: item.name })
    } catch (error) {
      this.setData({ loading: false, errorMessage: getErrorMessage(error) })
    }
  },

  handleCoverLoad() {
    this.clearCoverFallback()
    if (this.data.coverStatus === 'ready') return
    this.setData({ coverStatus: 'ready' })
  },

  handleCoverError() {
    this.clearCoverFallback()
    if (this.data.coverStatus === 'failed') return
    this.setData({ coverStatus: 'failed' })
  },

  editItem() {
    wx.navigateTo({ url: `/pages/item-form/index?id=${this.data.itemId}` })
  },

  /**
   * 修复旧正式版留下的“物品已保存、提醒任务没创建”。
   * requestSubscribeMessage 必须在 tap 的同步调用栈里发起，所以授权 Promise 要在任何 await 之前创建。
   */
  async handleEnableReminder() {
    const item = this.data.item
    if (!item?.canEnableReminder || this.data.actionLoading) return

    const authorization = requestReminderAuthorization()
    this.setData({ actionLoading: true })
    try {
      const accepted = await authorization
      if (!accepted) return

      const result = await armReminder(item._id)
      if (result.status === 'missed') {
        wx.showToast({ title: '提醒时间已过', icon: 'none' })
      } else {
        track('reminder_repaired_from_detail')
        wx.showToast({ title: '提醒已开启', icon: 'success' })
      }
      await this.loadItem()
    } catch (error) {
      this.handleActionError(error)
    } finally {
      this.setData({ actionLoading: false })
    }
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
