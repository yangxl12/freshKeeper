import { toInventoryCardItem } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { listTrash, permanentlyDeleteItem } from '../../services/inventory-service'
import { getSettings, updateSettings } from '../../services/settings-service'

const REMINDER_DAY_OPTIONS = Array.from({ length: 31 }, (_, value) => ({
  value,
  label: value === 0 ? '到期当天' : `提前 ${value} 天`,
}))

const PROFILE_STORAGE_KEY = 'mine_profile'
const FEEDBACK_STORAGE_KEY = 'mine_feedback'

const DEFAULT_NICKNAME = '保质记用户'

interface Profile {
  nickname: string
  avatar: string
}

type EntryKey = 'settings' | 'trash' | 'feedback' | 'help' | 'about'

let trashSearchTimer: number | undefined
let trashRequestSequence = 0

function readProfile(): Profile {
  try {
    const stored = wx.getStorageSync(PROFILE_STORAGE_KEY) as Profile | ''
    if (stored && typeof stored === 'object') {
      return { nickname: stored.nickname || DEFAULT_NICKNAME, avatar: stored.avatar || '' }
    }
  } catch (error) {
    // 读取失败时回退到默认资料
  }
  return { nickname: DEFAULT_NICKNAME, avatar: '' }
}

Page({
  data: {
    profile: { nickname: DEFAULT_NICKNAME, avatar: '' } as Profile,
    profileVisible: false,
    profileNickname: DEFAULT_NICKNAME,
    activeModal: '' as EntryKey | '',
    settingsLoading: true,
    settingsSaving: false,
    settingsError: '',
    reminderDayOptions: REMINDER_DAY_OPTIONS,
    reminderDayIndex: 1,
    savedReminderDayIndex: 1,
    hasReminderJobs: false,
    subscriptionMainSwitch: null as boolean | null,
    subscriptionSummary: '可在物品详情中逐件开启一次性提醒',
    trashLoading: false,
    trashLoadingMore: false,
    trashError: '',
    trashSearch: '',
    trashItems: [] as ReturnType<typeof toInventoryCardItem>[],
    trashNextCursor: null as string | null,
    feedbackText: '',
  },

  onShow() {
    this.syncTabBar()
    this.setData({ profile: readProfile() })
    void this.loadSettings()
    this.readSubscriptionSetting()
  },

  onUnload() {
    if (trashSearchTimer) clearTimeout(trashSearchTimer)
  },

  onPullDownRefresh() {
    Promise.all([this.loadSettings()]).finally(() => wx.stopPullDownRefresh())
    this.readSubscriptionSetting()
  },

  syncTabBar() {
    const tabBar = (
      this as unknown as {
        getTabBar?: () => { setData?: (data: Record<string, unknown>) => void } | undefined
      }
    ).getTabBar?.()
    tabBar?.setData?.({ selected: 1 })
  },

  async loadSettings() {
    this.setData({ settingsLoading: true, settingsError: '' })
    try {
      const settings = await getSettings()
      this.setData(
        {
          reminderDayIndex: settings.defaultReminderLeadDays,
          savedReminderDayIndex: settings.defaultReminderLeadDays,
          hasReminderJobs: Boolean(settings.hasReminderJobs),
          settingsLoading: false,
        },
        () => this.updateSubscriptionSummary(),
      )
    } catch (error) {
      this.setData({ settingsLoading: false, settingsError: getErrorMessage(error) })
    }
  },

  /* 资料 */
  openProfile() {
    this.setData({
      profileVisible: true,
      profileNickname: this.data.profile.nickname,
    })
  },

  closeProfile() {
    this.setData({ profileVisible: false })
  },

  handleNicknameInput(event: WechatMiniprogram.Input) {
    this.setData({ profileNickname: event.detail.value })
  },

  chooseAvatar(event: WechatMiniprogram.CustomEvent) {
    const avatarUrl = (event.detail as { avatarUrl?: string }).avatarUrl
    if (!avatarUrl) return
    let saved = avatarUrl
    try {
      const target = `${wx.env.USER_DATA_PATH}/mine-avatar.png`
      wx.getFileSystemManager().saveFileSync(avatarUrl, target)
      saved = target
    } catch (error) {
      // 保存失败时直接使用临时地址
    }
    this.setData({ 'profile.avatar': saved })
  },

  saveProfile() {
    const nickname = this.data.profileNickname.trim().slice(0, 20) || DEFAULT_NICKNAME
    const profile: Profile = { nickname, avatar: this.data.profile.avatar }
    try {
      wx.setStorageSync(PROFILE_STORAGE_KEY, profile)
    } catch (error) {
      // 存储失败时仍展示本次修改
    }
    this.setData({ profile, profileVisible: false })
    wx.showToast({ title: '资料已保存', icon: 'success' })
  },

  /* 入口弹窗 */
  openEntry(event: WechatMiniprogram.CustomEvent) {
    const key = event.currentTarget.dataset.entry as EntryKey
    if (!key) return
    this.setData({ activeModal: key })
    if (key === 'trash') void this.loadTrash(true)
  },

  closeModal() {
    if (this.data.settingsSaving) return
    this.setData({
      activeModal: '',
      settingsError: '',
      reminderDayIndex: this.data.savedReminderDayIndex,
    })
  },

  stopPropagation() {},

  noop() {},

  /* 提醒设置 */
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
        activeModal: '',
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
        this.setData({ subscriptionMainSwitch: subscriptions?.mainSwitch ?? null }, () =>
          this.updateSubscriptionSummary(),
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

  retrySettings() {
    void this.loadSettings()
  },

  /* 回收站 */
  async loadTrash(reset: boolean) {
    const requestSequence = ++trashRequestSequence
    if (reset) {
      this.setData({ trashLoading: true, trashError: '', trashItems: [], trashNextCursor: null })
    } else {
      this.setData({ trashLoadingMore: true })
    }

    try {
      const result = await listTrash({
        search: this.data.trashSearch,
        cursor: reset ? null : this.data.trashNextCursor,
      })
      if (requestSequence !== trashRequestSequence) return
      const pageItems = result.items.map(toInventoryCardItem)
      this.setData({
        trashItems: reset ? pageItems : [...this.data.trashItems, ...pageItems],
        trashNextCursor: result.nextCursor,
        trashLoading: false,
        trashLoadingMore: false,
        trashError: '',
      })
    } catch (error) {
      if (requestSequence !== trashRequestSequence) return
      this.setData({
        trashLoading: false,
        trashLoadingMore: false,
        trashError: getErrorMessage(error),
      })
    }
  },

  handleTrashSearch(event: WechatMiniprogram.Input) {
    this.setData({ trashSearch: event.detail.value })
    if (trashSearchTimer) clearTimeout(trashSearchTimer)
    trashSearchTimer = setTimeout(() => void this.loadTrash(true), 300) as unknown as number
  },

  clearTrashSearch() {
    if (trashSearchTimer) clearTimeout(trashSearchTimer)
    this.setData({ trashSearch: '' }, () => void this.loadTrash(true))
  },

  openTrashItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
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
      void this.loadTrash(true)
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  loadMoreTrash() {
    if (!this.data.trashNextCursor || this.data.trashLoadingMore) return
    void this.loadTrash(false)
  },

  retryTrash() {
    void this.loadTrash(true)
  },

  /* 意见反馈 */
  handleFeedbackInput(event: WechatMiniprogram.Input) {
    this.setData({ feedbackText: event.detail.value })
  },

  submitFeedback() {
    const content = this.data.feedbackText.trim()
    if (!content) {
      wx.showToast({ title: '请先写下你的建议', icon: 'none' })
      return
    }
    try {
      const history = (wx.getStorageSync(FEEDBACK_STORAGE_KEY) as string[]) || []
      wx.setStorageSync(FEEDBACK_STORAGE_KEY, [...history, content].slice(-20))
    } catch (error) {
      // 本地保存失败不影响反馈提示
    }
    this.setData({ feedbackText: '', activeModal: '' })
    wx.showToast({ title: '已收到，感谢反馈', icon: 'success' })
  },
})
