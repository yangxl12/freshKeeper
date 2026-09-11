import { toInventoryCardItem } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { listTrash, permanentlyDeleteItem } from '../../services/inventory-service'
import { readReminderAuthorization } from '../../services/reminder-service'
import { getSettings, updateSettings } from '../../services/settings-service'
import {
  deleteAccount,
  exportData,
  getUserProfile,
  shareExportedFile,
  updateProfile,
  uploadAvatarFile,
} from '../../services/user-service'
import { normalizeNickname } from '../../utils/nickname'
import { shouldMigrateProfile } from '../../utils/profile-migration'
import type { UserProfile, UserProfileUpdateInput } from '../../types/inventory'

const REMINDER_DAY_OPTIONS = Array.from({ length: 31 }, (_, value) => ({
  value,
  label: value === 0 ? '到期当天' : `提前 ${value} 天`,
}))

const PROFILE_STORAGE_KEY = 'mine_profile'
const PROFILE_MIGRATED_KEY = 'profile_migrated'
const FEEDBACK_STORAGE_KEY = 'mine_feedback'

const DEFAULT_NICKNAME = '保质记用户'
/** 资料读取节流：60s 内重复 onShow 不再请求云端。 */
const PROFILE_READ_TTL_MS = 60_000

interface Profile {
  nickname: string
  avatar: string
}

type EntryKey = 'settings' | 'trash' | 'feedback' | 'help' | 'about' | 'account'

let trashSearchTimer: number | undefined
let trashRequestSequence = 0
let profileReadAt = 0

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

/** 本地存储从「唯一数据源」降级为缓存：云端回来的内容顺手回写，离线时还能兜底渲染。 */
function writeProfileCache(profile: Profile): void {
  try {
    wx.setStorageSync(PROFILE_STORAGE_KEY, profile)
  } catch (error) {
    // 缓存写不进去不影响展示
  }
}

function profileFromRemote(remote: UserProfile): Profile {
  return { nickname: remote.nickname || DEFAULT_NICKNAME, avatar: remote.avatarFileId || '' }
}

function isMigrated(): boolean {
  try {
    return Boolean(wx.getStorageSync(PROFILE_MIGRATED_KEY))
  } catch (error) {
    return false
  }
}

Page({
  data: {
    profile: { nickname: DEFAULT_NICKNAME, avatar: '' } as Profile,
    profileVisible: false,
    profileNickname: DEFAULT_NICKNAME,
    /** 云端档案：判断存量迁移要靠它，不参与渲染。 */
    remoteProfile: null as UserProfile | null,
    profileSaving: false,
    avatarUploading: false,
    exporting: false,
    activeModal: '' as EntryKey | '',
    settingsLoading: true,
    settingsSaving: false,
    settingsError: '',
    reminderDayOptions: REMINDER_DAY_OPTIONS,
    reminderDayIndex: 1,
    savedReminderDayIndex: 1,
    hasReminderJobs: false,
    /** 微信订阅消息授权状态；由 reminder-service 折算，与「完整录入」共用同一份判断。 */
    subscriptionAuthorized: false,
    subscriptionSummary: '可在物品详情中逐件开启一次性提醒',
    trashLoading: false,
    trashLoadingMore: false,
    trashError: '',
    trashSearch: '',
    trashItems: [] as ReturnType<typeof toInventoryCardItem>[],
    trashNextCursor: null as string | null,
    feedbackText: '',
    /** 注销中：锁住弹窗关闭与按钮，避免删一半被打断。 */
    deletingAccount: false,
  },

  onShow() {
    this.syncTabBar()
    this.setData({ profile: readProfile() })
    // 资料与设置并发读：资料读失败静默降级，不该拖慢设置。
    void Promise.all([this.loadSettings(), this.loadProfile()])
  },

  onUnload() {
    if (trashSearchTimer) clearTimeout(trashSearchTimer)
  },

  onPullDownRefresh() {
    void this.loadSettings().finally(() => wx.stopPullDownRefresh())
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
      this.setData({
        reminderDayIndex: settings.defaultReminderLeadDays,
        savedReminderDayIndex: settings.defaultReminderLeadDays,
        hasReminderJobs: Boolean(settings.hasReminderJobs),
        settingsLoading: false,
      })
    } catch (error) {
      this.setData({ settingsLoading: false, settingsError: getErrorMessage(error) })
    }
    void this.readSubscriptionSetting()
  },

  /* 资料 */
  async loadProfile(force = false) {
    const now = Date.now()
    if (!force && profileReadAt && now - profileReadAt < PROFILE_READ_TTL_MS) return
    profileReadAt = now
    try {
      const remote = await getUserProfile()
      profileReadAt = Date.now()
      this.applyRemoteProfile(remote)
    } catch (error) {
      // 静默降级：本地缓存已经渲染出来了，资料读不到不影响任何核心操作。
      return
    }
  },

  /** 云端为准；云端还没资料的存量用户先沿用本地，迁移跑完自然被覆盖。 */
  applyRemoteProfile(remote: UserProfile) {
    const next = profileFromRemote(remote)
    const local = readProfile()
    const merged: Profile = {
      nickname: remote.nickname ? next.nickname : local.nickname,
      avatar: remote.avatarFileId ? next.avatar : local.avatar,
    }
    this.setData({ profile: merged, remoteProfile: remote })
    writeProfileCache(merged)
    if (!isMigrated() && shouldMigrateProfile(local, remote, DEFAULT_NICKNAME)) {
      void this.migrateLocalProfile(local)
    }
  },

  applyProfile(remote: UserProfile) {
    const profile = profileFromRemote(remote)
    this.setData({ profile, remoteProfile: remote })
    writeProfileCache(profile)
    // 刚写完云端，重置节流窗口，避免下次 onShow 立刻又读一次。
    profileReadAt = Date.now()
  },

  /** 存量迁移：本地资料推上云，头像传不动就只迁昵称，绝不因为头像失败整体失败。 */
  async migrateLocalProfile(local: Profile) {
    try {
      let avatarFileId: string | null = null
      if (local.avatar && !local.avatar.startsWith('cloud://')) {
        try {
          avatarFileId = await uploadAvatarFile(local.avatar)
        } catch (error) {
          avatarFileId = null
        }
      }
      const nickname = local.nickname === DEFAULT_NICKNAME ? null : normalizeNickname(local.nickname)
      // 头像只在真的传上去时才写：没传就一定不能把云端已有的头像清掉。
      const payload: UserProfileUpdateInput = { nickname }
      if (avatarFileId) payload.avatarFileId = avatarFileId
      await updateProfile(payload)
      try {
        wx.setStorageSync(PROFILE_MIGRATED_KEY, true)
      } catch (error) {
        // 标记写不进去最多导致重复迁移一次，可容忍。
      }
      // 头像没迁上去说明本地文件已经失效，清掉缓存里的死路径，避免图片一直加载失败。
      if (local.avatar && !avatarFileId && !local.avatar.startsWith('cloud://')) {
        writeProfileCache({ nickname: local.nickname, avatar: '' })
        this.setData({ 'profile.avatar': '' })
      }
      profileReadAt = 0
      void this.loadProfile(true)
    } catch (error) {
      // 迁移失败不打扰用户，下次还会再试。
    }
  },

  openProfile() {
    this.setData({
      profileVisible: true,
      profileNickname: this.data.profile.nickname,
    })
  },

  closeProfile() {
    if (this.data.profileSaving || this.data.avatarUploading) return
    this.setData({ profileVisible: false })
  },

  handleNicknameInput(event: WechatMiniprogram.Input) {
    this.setData({ profileNickname: event.detail.value })
  },

  /** 头像即选即传：压缩 → 取 cloudPath → 上传 → 写档案，不跟随「保存」按钮。 */
  async chooseAvatar(event: WechatMiniprogram.CustomEvent) {
    const avatarUrl = (event.detail as { avatarUrl?: string }).avatarUrl
    if (!avatarUrl || this.data.avatarUploading) return
    this.setData({ avatarUploading: true })
    wx.showLoading({ title: '正在上传头像', mask: true })
    try {
      const fileID = await uploadAvatarFile(avatarUrl)
      const updated = await updateProfile({ avatarFileId: fileID })
      wx.hideLoading()
      this.applyProfile(updated)
    } catch (error) {
      wx.hideLoading()
      await this.showError('头像没有保存成功', error)
    } finally {
      this.setData({ avatarUploading: false })
    }
  },

  async saveProfile() {
    if (this.data.profileSaving) return
    const nickname = normalizeNickname(this.data.profileNickname)
    this.setData({ profileSaving: true })
    try {
      const updated = await updateProfile({ nickname })
      this.applyProfile(updated)
      this.setData({ profileVisible: false, profileSaving: false })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (error) {
      this.setData({ profileSaving: false })
      await this.showError('资料没有保存成功', error)
    }
  },

  /** 结果提示一律用 modal：微信 toast 超过 7 个汉字会被截断。 */
  async showError(title: string, error: unknown) {
    await wx.showModal({
      title,
      content: getErrorMessage(error),
      showCancel: false,
      confirmText: '知道了',
    })
  },

  /* 入口弹窗 */
  openEntry(event: WechatMiniprogram.CustomEvent) {
    const key = event.currentTarget.dataset.entry as EntryKey
    if (!key) return
    this.setData({ activeModal: key })
    if (key === 'trash') void this.loadTrash(true)
  },

  closeModal() {
    if (this.data.settingsSaving || this.data.deletingAccount || this.data.exporting) return
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

  async readSubscriptionSetting() {
    const authorization = await readReminderAuthorization()
    this.setData({
      subscriptionAuthorized: authorization.authorized,
      // 授权已开启且已有提醒任务时，用更具体的说明覆盖通用文案。
      subscriptionSummary:
        authorization.authorized && this.data.hasReminderJobs
          ? '通知已开启，已有物品保存了提醒任务'
          : authorization.summary,
    })
  },

  openNotificationSettings() {
    wx.openSetting({
      withSubscriptions: true,
      complete: () => {
        void this.readSubscriptionSetting()
      },
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

  /* 数据导出（B2） */
  async startExport() {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    wx.showLoading({ title: '正在导出…', mask: true })
    try {
      const result = await exportData()
      wx.hideLoading()
      const shared = await shareExportedFile(result.fileID, result.fileName)
      this.setData({ exporting: false })
      if (shared) wx.showToast({ title: '已转发', icon: 'success' })
    } catch (error) {
      wx.hideLoading()
      this.setData({ exporting: false })
      await this.showError('导出没有完成', error)
    }
  },

  /* 账号注销（A2） */
  async startDeleteAccount() {
    if (this.data.deletingAccount) return

    const first = await wx.showModal({
      title: '注销账号？',
      content: '将永久删除：全部物品、回收站、提醒任务、提醒设置和云端封面图。',
      confirmText: '继续',
      confirmColor: '#A33F32',
    })
    if (!first.confirm) return

    const second = await wx.showModal({
      title: '确认注销，无法恢复',
      content: '注销后重新进入会是一个全新的空账号，已删除的数据找不回来。',
      confirmText: '确认注销',
      confirmColor: '#A33F32',
    })
    if (!second.confirm) return

    this.setData({ deletingAccount: true })
    wx.showLoading({ title: '正在删除…', mask: true })
    try {
      await deleteAccount()
      wx.hideLoading()
      try {
        wx.clearStorageSync()
      } catch (error) {
        // 清不掉本地缓存也不影响云端已删除。
      }
      await wx.showModal({
        title: '账号已注销',
        content: '你的数据已全部删除，重新进入就是全新的空账号。',
        showCancel: false,
        confirmText: '知道了',
      })
      wx.reLaunch({ url: '/pages/home/index' })
    } catch (error) {
      wx.hideLoading()
      this.setData({ deletingAccount: false })
      await wx.showModal({
        title: '注销未完成',
        content: `${getErrorMessage(error)}\n可以再试一次，重试是安全的。`,
        showCancel: false,
        confirmText: '知道了',
      })
    }
  },
})
