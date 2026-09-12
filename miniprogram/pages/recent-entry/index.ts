import {
  applyFormValuesToDraft,
  createDraftFromRecent,
  draftToFormPrefill,
  normalizeRecentName,
} from '../../domain/quick-entry'
import { getErrorMessage } from '../../services/cloud-client'
import { listRecentProfiles } from '../../services/quick-entry-service'
import { getSettings } from '../../services/settings-service'
import type { QuickEntryDraft, QuickEntryDraftFields, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'

/** 与 quick-entry 保持一致：未入库草稿 20 条封顶，满了就加不进来。 */
const MAX_DRAFTS = 20
const MAX_RECENT_PROFILES = 100

type RecentProfileRow = RecentItemProfile & { key: string }
type RecentProfileView = RecentProfileRow & { picked: boolean }

/** 顶部说明随名额变化，放在这里算，别在 wxml 里堆嵌套三元。 */
function introTextOf(slots: number, remaining: number): string {
  if (remaining <= 0) return `已选满 ${slots} 条，先带回去或移掉一条再加。`
  return `点一条改好数量和日期，可连续选多条，最后一起带回去。还能加 ${remaining} 条。`
}

Page({
  data: {
    loading: true,
    loadingError: '',
    keyword: '',
    profiles: [] as RecentProfileRow[],
    filteredProfiles: [] as RecentProfileView[],
    /** 已确认的草稿，按选择顺序排列；pickedKeys 与之一一对应，用来回填列表的已选态。 */
    picked: [] as QuickEntryDraft[],
    pickedKeys: [] as string[],
    slots: MAX_DRAFTS,
    remaining: MAX_DRAFTS,
    introText: introTextOf(MAX_DRAFTS, MAX_DRAFTS),
    /** 已选里还差到期日期的条数——带回去也是「待补全」，提前说清楚比回去才发现好。 */
    pendingCount: 0,
    limitNotice: '',
    defaultReminderLeadDays: 1,
    /** 弹窗开没开不能只看 editingIndex：新选的草稿还没进 picked，下标就是 -1。 */
    editorOpen: false,
    /** 非负表示正在改 picked 里的这一条；-1 表示正在改一条尚未加入的新草稿。 */
    editingIndex: -1,
    editingPicked: false,
  },

  /** 待确认的新草稿不进 data：它没有渲染诉求，进 data 只会白白深拷贝一遍。 */
  pendingDraft: null as QuickEntryDraft | null,
  pendingKey: '',

  onLoad(query: Record<string, string | undefined>) {
    // 录入页按剩余名额传 slots，这里再夹一次，避免手改 URL 撑爆草稿上限。
    const requested = Number(query?.slots)
    const slots = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_DRAFTS, Math.floor(requested)) : MAX_DRAFTS
    this.setData({ slots, remaining: slots, introText: introTextOf(slots, slots) })
    track('recent_entry_open', { slots })
    void this.loadProfiles()
  },

  async loadProfiles() {
    this.setData({ loading: true, loadingError: '' })
    const [recentResult, settingsResult] = await Promise.allSettled([
      listRecentProfiles(MAX_RECENT_PROFILES),
      getSettings(),
    ])
    // 同名物品只留最新一条，key 就用归一化后的名字，和列表去重规则一致。
    const profiles: RecentProfileRow[] = (recentResult.status === 'fulfilled' ? recentResult.value.items : [])
      .slice(0, MAX_RECENT_PROFILES)
      .map(item => ({ ...item, key: normalizeRecentName(item.name) || item.name }))
    this.setData({
      loading: false,
      profiles,
      defaultReminderLeadDays: settingsResult.status === 'fulfilled' ? settingsResult.value.defaultReminderLeadDays : 1,
      loadingError: recentResult.status === 'rejected'
        ? getErrorMessage(recentResult.reason) || '最近记录暂时读不出来，可以重试'
        : '',
    }, () => this.applyFilter())
  },

  retryLoad() {
    return this.loadProfiles()
  },

  /** 关键字过滤 + 已选态回填，列表任何一次变化都要经过这里。 */
  applyFilter() {
    const keyword = this.data.keyword.trim().toLowerCase()
    const pickedKeys = this.data.pickedKeys
    this.setData({
      filteredProfiles: this.data.profiles
        .filter(profile => !keyword || profile.name.toLowerCase().includes(keyword))
        .map(profile => ({ ...profile, picked: pickedKeys.includes(profile.key) })),
    })
  },

  handleKeywordInput(event: WechatMiniprogram.Input) {
    this.setData({ keyword: event.detail.value }, () => this.applyFilter())
  },

  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyFilter())
  },

  /**
   * 列表项只有两种走向：已选的点开是改数量/日期，未选的点开是加进已选。
   * wxml 的 index 是过滤后的下标，所以一律用 key 回查。
   */
  pickProfile(event: WechatMiniprogram.BaseEvent) {
    if (this.data.editorOpen) return
    const key = String(event.currentTarget.dataset.key || '')
    const profile = this.data.profiles.find(item => item.key === key)
    if (!profile) return
    const pickedIndex = this.data.pickedKeys.indexOf(key)
    if (pickedIndex >= 0) {
      this.openEditor(pickedIndex, true)
      return
    }
    if (this.data.picked.length >= this.data.slots) {
      this.setData({ limitNotice: `一次最多加 ${this.data.slots} 条，先「添加到录入」回去，或移掉一条再加` })
      return
    }
    this.pendingDraft = createDraftFromRecent(profile, this.data.defaultReminderLeadDays)
    this.pendingKey = key
    this.setData({ limitNotice: '' }, () => this.openEditor(-1, false))
  },

  openEditor(pickedIndex: number, isPicked: boolean) {
    const draft = isPicked ? this.data.picked[pickedIndex] : this.pendingDraft
    if (!draft) return
    this.setData({ editorOpen: true, editingIndex: pickedIndex, editingPicked: isPicked }, () => {
      this.withForm(form => form.applyPrefill(draftToFormPrefill(draft), ''))
    })
  },

  /** 组件首次渲染后 selectComponent 才可用，失败时退到下一帧再取一次。 */
  withForm(consumer: (form: any) => void) {
    const form = this.selectComponent?.('#recentForm')
    if (form) {
      consumer(form as any)
      return
    }
    setTimeout(() => {
      const retry = this.selectComponent?.('#recentForm')
      if (retry) consumer(retry as any)
    }, 40)
  },

  closeEditor() {
    this.pendingDraft = null
    this.pendingKey = ''
    this.setData({ editorOpen: false, editingIndex: -1, editingPicked: false })
  },

  /** 动过表单才拦一下，没动过直接退。 */
  requestCloseEditor() {
    const form: any = this.selectComponent?.('#recentForm')
    if (form?.isDirty?.()) {
      wx.showModal({
        title: '放弃这次修改？',
        content: '改动还没点「完成」确定，退出不会保存。',
        confirmText: '放弃修改',
        cancelText: '继续编辑',
        confirmColor: '#b84a3e',
        success: (result) => { if (result.confirm) this.closeEditor() },
      })
      return
    }
    this.closeEditor()
  },

  confirmEditor() {
    this.withForm(form => form.save())
  },

  /** 表单点「完成」：此刻才把表单值写成草稿并落进已选。 */
  handleFormSubmit(event: WechatMiniprogram.CustomEvent) {
    const fields = event.detail as QuickEntryDraftFields
    const { editingIndex, editingPicked } = this.data
    if (editingPicked) {
      const current = this.data.picked[editingIndex]
      if (!current) {
        this.closeEditor()
        return
      }
      const picked = [...this.data.picked]
      picked[editingIndex] = applyFormValuesToDraft(current, fields)
      this.commitPicked(picked, this.data.pickedKeys)
      track('recent_entry_edit')
      return
    }
    if (!this.pendingDraft) {
      this.closeEditor()
      return
    }
    const draft = applyFormValuesToDraft(this.pendingDraft, fields)
    this.commitPicked([...this.data.picked, draft], [...this.data.pickedKeys, this.pendingKey])
    track('recent_entry_pick', { source: 'recent' })
  },

  /** 编辑已选项时点「移出已选」：丢掉这一条，其余保留。 */
  removePicked() {
    const index = this.data.editingIndex
    if (index < 0) return
    this.commitPicked(
      this.data.picked.filter((_draft, itemIndex) => itemIndex !== index),
      this.data.pickedKeys.filter((_key, itemIndex) => itemIndex !== index),
    )
    track('recent_entry_remove')
  },

  clearPicked() {
    const count = this.data.picked.length
    if (!count) return
    wx.showModal({
      title: '清空已选？',
      content: `已选的 ${count} 条会全部移出，不会加入库存。`,
      confirmText: '清空',
      confirmColor: '#b84a3e',
      success: (result) => { if (result.confirm) this.commitPicked([], []) },
    })
  },

  commitPicked(picked: QuickEntryDraft[], pickedKeys: string[]) {
    this.pendingDraft = null
    this.pendingKey = ''
    const remaining = Math.max(0, this.data.slots - picked.length)
    this.setData({
      picked,
      pickedKeys,
      remaining,
      introText: introTextOf(this.data.slots, remaining),
      pendingCount: picked.filter(draft => draft.issues.length > 0).length,
      limitNotice: '',
      editorOpen: false,
      editingIndex: -1,
      editingPicked: false,
    }, () => this.applyFilter())
  },

  /** 一次性把已选草稿交回录入页——emit 是同步的，紧接着返回即可。 */
  confirmPicked() {
    const drafts = this.data.picked
    if (!drafts.length) return
    const channel = this.getOpenerEventChannel?.()
    if (typeof channel?.emit === 'function') channel.emit('pickedDrafts', { drafts })
    track('recent_entry_confirm', { count: drafts.length })
    wx.navigateBack({ fail: () => { /* 页面栈异常时留在本页，用户还能手动返回 */ } })
  },

  /** 遮罩挡住滚动穿透用，不做任何事。 */
  noop() {},
})
