import {
  applyFormValuesToDraft,
  createDraftFromParsed,
  draftToFormPrefill,
  draftToInventoryInput,
  draftToManualFields,
  getExpirySummary,
  normalizeRecentName,
  parseQuickTextLocally,
  refreshDraftValidation,
} from '../../domain/quick-entry'
import { getErrorMessage, CloudServiceError } from '../../services/cloud-client'
import { generateItemCover, saveItem } from '../../services/inventory-service'
import {
  getQuickEntryCapabilities,
  listRecentProfiles,
  parseQuickText,
} from '../../services/quick-entry-service'
import { armReminder, requestReminderAuthorization } from '../../services/reminder-service'
import { resolveReminderTime } from '../../domain/reminder-time'
import { getSettings } from '../../services/settings-service'
import type { QuickEntryDraft, QuickEntryDraftFields, QuickEntryParseResult, QuickEntrySource, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { markPendingHomeSort } from '../../utils/home-intent'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'
import { todayKey } from '../../domain/quick-text'
import { toDayOrdinal } from '../../utils/date-key'

const MAX_DRAFTS = 20
/** 最近录入最多展示条目数，超过后不再继续拉取。 */
const MAX_RECENT_PROFILES = 100
/** AI 识别超过这个时长就换一句更耐等的文案，别让「AI 识别中…」僵在那儿。 */
const AI_PATIENCE_MS = 3000
/** 识别不到结构化结果时的兜底名称，保证用户始终能看到一条可编辑草稿。 */
function fallbackDraftName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40)
}

const SOURCE_LABELS: Record<QuickEntrySource, string> = {
  recent: '最近记录',
  text: '文字识别',
  manual: '手动填写',
}

function daysUntil(dateKey: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  try {
    return toDayOrdinal(dateKey) - toDayOrdinal(today)
  } catch (_error) {
    return null
  }
}

/** 到期信息的人话描述，让用户一眼看懂还剩多久。 */
function expiryBadgeText(summary: string, today: string): string {
  const days = daysUntil(summary, today)
  if (days === null) return '待补充'
  if (days < 0) return `已过期 ${Math.abs(days)} 天`
  if (days === 0) return '今天到期'
  if (days === 1) return '明天到期'
  return `还剩 ${days} 天`
}

function expiryToneOf(summary: string, today: string): 'fresh' | 'soon' | 'expired' | 'empty' {
  const days = daysUntil(summary, today)
  if (days === null) return 'empty'
  if (days < 0) return 'expired'
  return days <= 3 ? 'soon' : 'fresh'
}

/** 能加入库存的草稿：选中、无待补问题且状态可保存。 */
function countSelectable(drafts: QuickEntryDraft[]): number {
  return drafts.filter((draft) => draft.selected && !draft.issues.length && draft.status === 'savable').length
}

/** 还没达到可入库条件的未保存草稿数，用于底部按钮上方的必要提示。 */
function countPending(drafts: QuickEntryDraft[]): number {
  return drafts.filter((draft) => draft.status !== 'saved' && !(draft.selected && !draft.issues.length && draft.status === 'savable')).length
}

/** 未入库的草稿数：草稿条数上限按它算，已加入库存的卡片不占名额。 */
function countUnfinished(drafts: QuickEntryDraft[]): number {
  return drafts.filter((draft) => draft.status !== 'saved').length
}

function statusMeta(draft: QuickEntryDraft): { label: string; tone: string } {
  if (draft.status === 'saved') return { label: '已加入库存', tone: 'done' }
  if (draft.status === 'saving') return { label: '正在保存', tone: 'busy' }
  if (draft.status === 'failed') return { label: '保存失败', tone: 'alert' }
  if ((draft.confirmationFields || []).length) return { label: '待确认', tone: 'warn' }
  if (draft.issues.length) return { label: '待补全', tone: 'warn' }
  return { label: '可入库', tone: 'ok' }
}

/** AI 只在原文里找得到证据时才返回字段；缺失的字段已被默认值填上，这里提示用户核对。 */
function aiMissingHint(draft: QuickEntryDraft): string {
  const missing = draft.aiMissingFields || []
  if (!missing.length) return ''
  const labels = [missing.includes('quantity') ? '数量' : '', missing.includes('unit') ? '单位' : ''].filter(Boolean)
  return `AI 没在原文里找到${labels.join('和')}，已按默认值填上，请核对`
}

Page({
  data: {
    today: todayKey(),
    inputError: '',
    inputText: '',
    quickInputFocused: true,
    quickKeyboardHeight: 0,
    activeTab: 'quick' as 'quick' | 'full',
    fullMounted: false,
    /** 只作识别结果的分类/存放位置匹配用，列表已搬到 pages/recent-entry。 */
    recentProfiles: [] as RecentItemProfile[],
    drafts: [] as QuickEntryDraft[],
    features: QUICK_ENTRY_FEATURES,
    capabilities: { text: true, aiText: false },
    defaultReminderLeadDays: 1,
    recognitionState: 'idle' as 'idle' | 'parsing',
    recognitionTip: '正在识别…',
    saving: false,
    selectableCount: 0,
    pendingCount: 0,
    saveSummary: '',
    /** 达到草稿条数上限时「从最近录入添加」直接置灰，避免点了才被顶回来。 */
    draftLimitReached: false,
    maxDrafts: MAX_DRAFTS,
    editingIndex: -1,
  },

  onLoad() {
    this.recognitionId = 0
    this.openedAt = Date.now()
    track('quick_entry_open')
    void this.preparePage()
  },

  onUnload() {
    track('quick_entry_session_end', { saved_count: this.savedCount, duration_ms: Date.now() - this.openedAt })
    this.cancelRecognition()
  },

  recognitionId: 0,
  openedAt: 0,
  savedCount: 0,
  manualHandoff: false,
  exitOnShow: false,
  pendingRecognition: false,
  recognitionTipTimer: null as ReturnType<typeof setTimeout> | null,

  onShow() {
    this.manualHandoff = false
    wx.setNavigationBarTitle({ title: '物品录入' })
    if (this.exitOnShow) { wx.disableAlertBeforeUnload?.(); wx.navigateBack(); return }
    this.setData({ today: todayKey() })
    this.syncUnloadPrompt()
  },

  onHide() {
    this.resetQuickKeyboardHeight()
  },

  cancelRecognition() {
    if (this.data.recognitionState !== 'idle') wx.hideLoading?.()
    this.recognitionId += 1
    this.pendingRecognition = false
    this.clearRecognitionTip()
    this.setData({ recognitionState: 'idle' })
  },

  clearRecognitionTip() {
    if (this.recognitionTipTimer) clearTimeout(this.recognitionTipTimer)
    this.recognitionTipTimer = null
  },

  /** AI 走大模型要等 1~3 秒；真等久了就换文案，用户不会以为卡死。 */
  startRecognitionTip() {
    this.clearRecognitionTip()
    if (!(this.data.features.aiParse && this.data.capabilities.aiText)) return
    this.recognitionTipTimer = setTimeout(() => {
      this.recognitionTipTimer = null
      if (this.data.recognitionState === 'parsing') this.setData({ recognitionTip: '正在仔细识别…' })
    }, AI_PATIENCE_MS)
  },

  async preparePage() {
    const [recentResult, capabilityResult, settingsResult] = await Promise.allSettled([
      QUICK_ENTRY_FEATURES.recent ? listRecentProfiles(MAX_RECENT_PROFILES) : Promise.resolve({ items: [] }),
      getQuickEntryCapabilities(),
      getSettings(),
    ])
    // 最近记录在本页只用来给识别结果补分类和存放位置；列表交互已经搬到 pages/recent-entry，
    // 所以这里拉失败就静默降级，不拿「最近物品不可用」去打扰正在录入的人。
    const recentProfiles = (recentResult.status === 'fulfilled' ? recentResult.value.items : []).slice(0, MAX_RECENT_PROFILES)
    const capabilities = capabilityResult.status === 'fulfilled'
      ? capabilityResult.value
      : { text: false, aiText: false }
    const features = QUICK_ENTRY_FEATURES
    const defaultReminderLeadDays = settingsResult.status === 'fulfilled'
      ? settingsResult.value.defaultReminderLeadDays
      : 1
    const normalizedCapabilities = { ...capabilities, text: true, aiText: Boolean(capabilities.aiText) }
    this.setData({
      recentProfiles,
      features,
      capabilities: normalizedCapabilities,
      defaultReminderLeadDays,
    })
    // 一路都没有可用的录入方式时直接落到完整录入，别让用户对着空白页发呆。
    if (recentResult.status === 'fulfilled' && !recentProfiles.length
      && !features.text) {
      this.openFullTab()
    }
  },

  async refreshRecentProfiles() {
    try {
      const result = await listRecentProfiles(MAX_RECENT_PROFILES)
      this.setData({ recentProfiles: result.items.slice(0, MAX_RECENT_PROFILES) })
    } catch (_error) {
      // 只影响识别结果的分类匹配，静默保留旧数据。
    }
  },

  switchTab(event: WechatMiniprogram.BaseEvent) {
    const tab = event.currentTarget.dataset.tab as 'quick' | 'full'
    if (!tab || tab === this.data.activeTab) return
    if (this.data.saving && tab === 'full') return
    if (tab === 'full') this.openFullTab()
    else {
      this.setData({ activeTab: 'quick', quickInputFocused: true })
    }
  },

  openFullTab() {
    this.cancelRecognition()
    this.blurQuickInput()
    track('quick_entry_switch_tab', { tab: 'full' })
    this.setData({ activeTab: 'full', fullMounted: true })
  },

  handleFullFormSaved(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as unknown as {
      restoring: boolean
      name: string
      reminderSetupState?: 'unchanged' | 'ready' | 'not-enabled' | 'failed' | 'missed'
    }
    wx.disableAlertBeforeUnload?.()
    const reminderIncomplete = detail.reminderSetupState === 'not-enabled' || detail.reminderSetupState === 'failed'
    const reminderMissed = detail.reminderSetupState === 'missed'
    wx.showToast({
      title: reminderIncomplete
        ? '已保存，提醒未开启'
        : reminderMissed
          ? '已保存，提醒时间已过'
          : detail.restoring ? '已重新入库' : '已加入库存',
      icon: reminderIncomplete || reminderMissed ? 'none' : 'success',
      duration: reminderIncomplete || reminderMissed ? 2500 : 1500,
    })
    // 保存成功后直接回首页，配合录入时间排序让用户看到刚录入的物品。
    markPendingHomeSort()
    wx.navigateBack()
  },

  /** 保存成功后退出到首页；页面栈里没有首页时（如扫码直达）退回 tab。 */
  exitToHome() {
    markPendingHomeSort()
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  /** 组件首次渲染后 selectComponent 才可用，失败时退到下一帧再取一次。 */
  withForm(selector: string, consumer: (form: any) => void) {
    const form = this.selectComponent?.(selector)
    if (form) {
      consumer(form as any)
      return
    }
    setTimeout(() => {
      const retry = this.selectComponent?.(selector)
      if (retry) consumer(retry as any)
    }, 40)
  },

  /**
   * 「从最近录入添加」跳到独立页面完成选择：那边有原生返回、可搜索、能连续选多条，
   * 不再把本页整块视图替换成一个没有导航栏的伪列表。
   */
  openRecentEntry() {
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    const slots = MAX_DRAFTS - countUnfinished(this.data.drafts)
    if (slots <= 0) {
      this.setData({ inputError: `一次最多 ${MAX_DRAFTS} 条草稿，请先加入库存或删除已有卡片` })
      return
    }
    this.cancelRecognition()
    this.blurQuickInput()
    this.setData({ inputError: '' })
    track('recent_entry_open', { slots })
    wx.navigateTo({
      url: `/pages/recent-entry/index?slots=${slots}`,
      events: {
        // eventChannel 的 emit 是同步的，回到本页前草稿已经落进列表。
        pickedDrafts: (payload: { drafts?: QuickEntryDraft[] }) => this.appendRecentDrafts(payload?.drafts),
      },
    })
  },

  /** 最近录入页带回来的草稿整批插到最前，批内保持用户在那边确认的顺序。 */
  appendRecentDrafts(drafts?: QuickEntryDraft[]) {
    if (!Array.isArray(drafts) || !drafts.length) return
    const existing = this.data.drafts.filter((draft) => draft.status !== 'saved')
    const accepted = drafts.slice(0, Math.max(0, MAX_DRAFTS - existing.length))
    if (!accepted.length) {
      this.setData({ inputError: `一次最多 ${MAX_DRAFTS} 条草稿，请先处理当前草稿` })
      return
    }
    this.setData({ saveSummary: '', inputError: '' })
    this.commitDrafts([...accepted, ...existing])
    track('recent_item_select', { count: accepted.length })
  },

  /** 卡片任意位置都可进编辑；saving/saved/failed 的卡片没有可编辑状态，静默忽略。 */
  openDraftEditor(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const draft = this.data.drafts[index]
    if (this.data.saving || !draft || ['saving', 'saved', 'failed'].includes(draft.status)) return
    this.blurQuickInput()
    this.openDraftForm(index)
  },

  /**
   * 打开草稿编辑：把草稿灌进共用的完整录入表单。
   * 表单里的改动先留在表单里，只有点「完成」才回写草稿（handleDraftFormSubmit）。
   */
  openDraftForm(index: number) {
    this.setData({ editingIndex: index }, () => {
      const target = this.data.drafts[index]
      if (target) this.withForm('#draftForm', (form) => form.applyPrefill(draftToFormPrefill(target), ''))
    })
  },

  dismissDraftEditor() {
    this.setData({ editingIndex: -1 })
  },

  closeDraftEditor() {
    if (this.data.saving) return
    this.dismissDraftEditor()
  },

  /** 退出编辑表单前的二次提醒：动过表单才问一句，没动过直接退。 */
  requestCloseDraftEditor() {
    if (this.data.saving) return
    if (!this.isDraftFormDirty()) {
      this.closeDraftEditor()
      return
    }
    wx.showModal({
      title: '放弃修改？',
      content: '改动还没点「完成」确定，退出不会保存。',
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      confirmColor: '#b84a3e',
      success: (result) => { if (result.confirm) this.closeDraftEditor() },
    })
  },

  isDraftFormDirty(): boolean {
    const form: any = this.selectComponent?.('#draftForm')
    return Boolean(form?.isDirty?.())
  },

  /** 弹窗底部「完成」：把表单里的值交给表单自己走一遍（草稿模式只回传不落库）。 */
  confirmDraftEditor() {
    if (this.data.saving || this.data.editingIndex < 0) return
    this.withForm('#draftForm', (form) => form.save())
  },

  /** 遮罩挡住滚动穿透用，不做任何事。 */
  noop() {},

  /** 编辑表单点「完成」：表单值此刻才真正回写草稿。 */
  handleDraftFormSubmit(event: WechatMiniprogram.CustomEvent) {
    const { editingIndex } = this.data
    const draft = this.data.drafts[editingIndex]
    if (this.data.saving || editingIndex < 0 || !draft) {
      this.dismissDraftEditor()
      return
    }
    const drafts = [...this.data.drafts]
    drafts[editingIndex] = applyFormValuesToDraft(draft, event.detail as QuickEntryDraftFields)
    this.commitDrafts(drafts)
    this.dismissDraftEditor()
    track('draft_form_submit', { source: draft.source })
  },

  /** 底部「继续添加」：先复位再聚焦，已聚焦时也能可靠拉起键盘。 */
  focusQuickInput() {
    this.setData({ quickInputFocused: false })
    setTimeout(() => this.setData({ quickInputFocused: true }), 60)
  },

  /**
   * 卡片展示需要的派生信息，直接挂到每条草稿的 `view` 上一起下发。
   *
   * 原来是 11 个按索引对齐的平行数组，每次 commitDrafts 都是 14 个 key 的 setData；
   * 更要命的是平行数组一旦和 drafts 错位（filter / 插入就会）卡片会串位。
   * 挂到草稿对象上后 setData 只剩 drafts + 3 个计数，也不存在对齐问题。
   */
  withDraftViews(drafts: QuickEntryDraft[]): QuickEntryDraft[] {
    const today = this.data.today
    return drafts.map((draft) => {
      const summary = getExpirySummary(draft)
      const tone = expiryToneOf(summary, today)
      const meta = statusMeta(draft)
      return {
        ...draft,
        view: {
          expirySummary: summary,
          expiryBadge: expiryBadgeText(summary, today),
          expiryTone: tone,
          expired: tone === 'expired',
          statusLabel: meta.label,
          statusTone: meta.tone,
          sourceLabel: SOURCE_LABELS[draft.source] || '录入',
          aiFlag: Boolean(draft.parserVersion?.startsWith('ai-')),
          aiMissingHint: aiMissingHint(draft),
          nameMissing: draft.issues.some((issue) => issue.field === 'name'),
        },
      }
    })
  },

  commitDrafts(drafts: QuickEntryDraft[]) {
    this.setData({
      drafts: this.withDraftViews(drafts),
      selectableCount: countSelectable(drafts),
      pendingCount: countPending(drafts),
      draftLimitReached: countUnfinished(drafts) >= MAX_DRAFTS,
    }, () => this.syncUnloadPrompt())
  },

  syncUnloadPrompt() {
    if (this.manualHandoff) return
    const shouldWarn = Boolean(this.data.inputText.trim() || this.data.drafts.some((draft) => draft.status !== 'saved'))
    if (shouldWarn) wx.enableAlertBeforeUnload?.({ message: '放弃本次录入？' })
    else wx.disableAlertBeforeUnload?.()
  },

  handleQuickKeyboardHeightChange(event: WechatMiniprogram.CustomEvent<{ height?: number }>) {
    // 让整个底部输入卡片避让键盘，包括文本框下方的操作按钮。
    const height = Number(event.detail.height)
    this.setData({ quickKeyboardHeight: Number.isFinite(height) ? Math.max(0, height) : 0 })
  },

  handleQuickInputFocus(event: WechatMiniprogram.CustomEvent<{ height?: number }>) {
    this.setData({ quickInputFocused: true })
    this.handleQuickKeyboardHeightChange(event)
  },

  handleQuickInputBlur() {
    this.setData({ quickInputFocused: false })
    this.resetQuickKeyboardHeight()
  },

  /** 提交后必须收起输入法：textarea 开了 hold-keyboard，点按钮不会自动收起。 */
  blurQuickInput() {
    wx.hideKeyboard?.()
    this.setData({ quickInputFocused: false, quickKeyboardHeight: 0 })
  },

  resetQuickKeyboardHeight() {
    this.setData({ quickKeyboardHeight: 0 })
  },

  handleQuickTextInput(event: WechatMiniprogram.Input) {
    // 原文没有变化的重复事件不应让正在生成的结果作废。
    if (event.detail.value === this.data.inputText) return
    if (this.data.recognitionState === 'parsing') this.cancelRecognition()
    this.setData({ inputText: event.detail.value, inputError: '' }, () => this.syncUnloadPrompt())
  },

  handleGenerateTap() {
    return this.generateDrafts('text')
  },

  handleGenerateSubmit(event: WechatMiniprogram.CustomEvent) {
    // 使用原生表单快照，避免手机键盘尚未收起时读取到旧的 inputText。
    const text = event.detail.value?.quickText
    if (typeof text !== 'string') {
      this.setData({ inputError: '未获取到输入内容，请重试' })
      return
    }
    this.handleQuickTextInput({ detail: { value: text } } as WechatMiniprogram.Input)
    return this.handleGenerateTap()
  },

  async generateDrafts(_event?: WechatMiniprogram.BaseEvent | 'text') {
    const source: Extract<QuickEntrySource, 'text'> = 'text'
    const text = this.data.inputText.trim()
    if (!text) {
      this.setData({ inputError: '请输入物品和日期' })
      return
    }
    if (this.pendingRecognition || this.data.saving) return
    // 上一次识别异常中断留下状态时再点会完全没反应，这里先自愈。
    if (this.data.recognitionState !== 'idle') this.cancelRecognition()
    // 先把输入法收起来，草稿卡片才不会被键盘挡住。
    this.blurQuickInput()
    const recognitionId = ++this.recognitionId
    this.pendingRecognition = true
    const aiParsing = Boolean(this.data.features.aiParse && this.data.capabilities.aiText)
    this.setData({ recognitionState: 'parsing', inputError: '', recognitionTip: aiParsing ? 'AI 识别中…' : '正在识别…' })
    this.startRecognitionTip()
    const startedAt = Date.now()
    wx.showLoading?.({ title: '正在生成…', mask: true })
    try {
      const built = await this.buildDraftsFromText(text, source)
      if (recognitionId !== this.recognitionId) return
      const existing = this.data.drafts.filter(draft => draft.status !== 'saved')
      if (existing.length + built.drafts.length > MAX_DRAFTS) {
        this.setData({ recognitionState: 'idle', inputError: `一次最多 ${MAX_DRAFTS} 条草稿，请先加入库存或删除已有卡片` })
        return
      }
      this.setData({ recognitionState: 'idle', saveSummary: '', inputError: built.notice, inputText: '' })
      // 清空输入框后再次收起输入法，避免残留焦点把卡片顶出屏幕。
      this.blurQuickInput()
      // 后添加的排在最前：新一批整批插到顶部，批内保持原文顺序。
      this.commitDrafts([...built.drafts, ...existing])
      track('quick_parse_result', { result: built.notice ? 'fallback' : 'success', duration_ms: Date.now() - startedAt, draft_count: built.drafts.length })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('quick_parse_result', { result: 'failed', duration_ms: Date.now() - startedAt, failure_code: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    } finally {
      if (recognitionId === this.recognitionId) {
        wx.hideLoading?.()
        this.pendingRecognition = false
        this.clearRecognitionTip()
        this.setData({ recognitionState: 'idle' })
      }
    }
  },

  /** 云端优先，失败或结果为空时退到本地解析；仍识别不出时产出一条可手填的草稿。 */
  async buildDraftsFromText(text: string, source: Extract<QuickEntrySource, 'text'>): Promise<{ drafts: QuickEntryDraft[]; notice: string }> {
    const { items, parserVersion } = await this.recognizeTextItems(text)
    if (!items.length) {
      const draft = createDraftFromParsed(
        { name: fallbackDraftName(text), dateCandidates: [] },
        source,
        this.data.defaultReminderLeadDays,
        undefined,
        { kind: 'text', sourceText: text },
        parserVersion,
      )
      return { drafts: [draft], notice: '没识别出明确信息，已生成一条草稿，补全名称和日期即可保存' }
    }
    const drafts = items.map((item) => {
      const itemName = typeof item.name === 'string' ? normalizeRecentName(item.name) : ''
      const recent = itemName ? this.data.recentProfiles.find((profile) => normalizeRecentName(profile.name) === itemName) : undefined
      return createDraftFromParsed(item, source, this.data.defaultReminderLeadDays, recent, { kind: 'text', sourceText: text }, parserVersion)
    })
    return { drafts, notice: '' }
  },

  async recognizeTextItems(text: string): Promise<{ items: QuickEntryParseResult['items']; parserVersion: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // 云函数未回调也必须结束等待，让本地解析接管；迟到结果不会覆盖草稿。
      const result = await Promise.race([
        parseQuickText(text),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CloudServiceError('QUICK_ENTRY_TIMEOUT', '识别超时')), 8000)
        }),
      ])
      const items = Array.isArray(result?.items) ? result.items : []
      if (items.length) return { items, parserVersion: result.parserVersion || 'unknown' }
    } catch (error) {
      if (!(error instanceof CloudServiceError)) {
        const local = parseLocallySafely(text)
        if (local.length) return { items: local, parserVersion: 'rules-v3' }
        throw error
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    return { items: parseLocallySafely(text), parserVersion: 'rules-v3' }
  },

  updateDraft(index: number, mutator: (draft: QuickEntryDraft) => QuickEntryDraft) {
    const current = this.data.drafts[index]
    if (this.data.saving || !current || ['saving', 'saved', 'failed'].includes(current.status)) return
    const drafts = [...this.data.drafts]
    drafts[index] = refreshDraftValidation(mutator(current))
    this.commitDrafts(drafts)
  },

  toggleSelected(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateDraft(index, (draft) => ({ ...draft, selected: !draft.selected }))
  },

  removeDraft(event: WechatMiniprogram.BaseEvent) {
    if (this.data.saving) return
    const index = Number(event.currentTarget.dataset.index)
    const draft = this.data.drafts[index]
    if (!draft) return
    wx.showModal({ title: '移除这条草稿？', content: `将移除“${draft.fields.name || '未命名物品'}”，不会加入库存。`, confirmText: '移除', confirmColor: '#b84a3e', success: result => {
      if (!result.confirm || this.data.saving) return
      this.commitDrafts(this.data.drafts.filter((_item, itemIndex) => itemIndex !== index))
    } })
  },

  continueManual(event?: WechatMiniprogram.BaseEvent) {
    if (this.data.saving) return
    this.cancelRecognition()
    const index = event?.currentTarget?.dataset?.index
    const draft = index == null ? this.data.drafts.find(item => item.status !== 'saved') : this.data.drafts[Number(index)]
    if (draft?.status === 'failed') {
      this.setData({ inputError: '这条草稿保存结果尚未确认，请先重试确认，避免重复入库' })
      return
    }
    track('quick_entry_manual', { source: draft?.source || 'manual' })
    this.manualHandoff = true
    wx.disableAlertBeforeUnload?.()
    this.setData({ activeTab: 'full', fullMounted: true, inputText: '', inputError: '' }, () => {
      this.withForm('#fullForm', (form) => form.applyPrefill(draft ? draftToManualFields(draft) : null, draft?.saveKey || ''))
      this.commitDrafts(this.data.drafts.filter(item => item.status === 'saved'))
      this.manualHandoff = false
      this.syncUnloadPrompt()
    })
  },

  /** 保存成功后逐条生成 AI 封面：串行避开生图并发限制，失败静默（卡片保持默认占位图）。 */
  async requestCovers(itemIds: string[]) {
    for (const itemId of itemIds) {
      try {
        await generateItemCover(itemId)
      } catch (_error) {
        // 封面生成失败不影响保存结果，物品继续用默认占位图。
      }
    }
  },

  retryDraft(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const draft = this.data.drafts[index]
    if (!draft || draft.status !== 'failed' || this.data.saving) return
    void this.persistDrafts([{ draft, index }])
  },

  async saveDrafts() {
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    const targets = this.data.drafts.map((draft, index) => ({ draft, index })).filter(({ draft }) => draft.selected && !draft.issues.length && draft.status === 'savable')
    await this.persistDrafts(targets)
  },

  async persistDrafts(targets: Array<{ draft: QuickEntryDraft; index: number }>) {
    if (this.data.saving) return
    if (!targets.length) return
    const savingDrafts = this.data.drafts.map((draft, index) => targets.some((target) => target.index === index) ? { ...draft, status: 'saving' as const } : draft)
    this.setData({ saving: true, saveSummary: '' })
    this.commitDrafts(savingDrafts)
    const results = await Promise.allSettled(targets.map(({ draft }) => {
      const result = draftToInventoryInput(draft)
      const input = draft.submittedInput || result.input
      if (input) draft.submittedInput = input
      return input ? saveItem(input, { idempotencyKey: draft.saveKey }) : Promise.reject(new Error('草稿信息不完整'))
    }))
    const updated = [...savingDrafts]
    let succeeded = 0
    let failed = 0
    /** 保存成功的条目统一补一次到期提醒预约（提醒时间是算出来的，没有开关）。 */
    const reminderTargets: Array<{ itemId: string; draft: QuickEntryDraft }> = []
    results.forEach((result, resultIndex) => {
      const target = targets[resultIndex]
      if (result.status === 'fulfilled') {
        updated[target.index] = { ...target.draft, status: 'saved', selected: false, evidence: undefined }
        succeeded += 1
        reminderTargets.push({ itemId: result.value.itemId, draft: target.draft })
      } else {
        updated[target.index] = { ...target.draft, status: 'failed', selected: false, errorMessage: getErrorMessage(result.reason) }
        failed += 1
      }
    })
    this.savedCount += succeeded
    this.commitDrafts(updated)
    const savedItemIds = results
      .map((result) => (result.status === 'fulfilled' ? result.value.itemId : ''))
      .filter(Boolean)
    if (savedItemIds.length) void this.requestCovers(savedItemIds)
    // 提醒授权必须在保存期间完成：这里还压着 saving 状态，用户不会重复点「加入库存」，
    // 而下面的 exitToHome 也要等授权弹窗收完才跳转。
    const remindersReady = reminderTargets.length ? await this.armSavedReminders(reminderTargets) : true
    this.setData({ saving: false, saveSummary: failed ? `已成功 ${succeeded} 条，失败 ${failed} 条` : '' })
    track('quick_entry_save_result', { result: failed ? (succeeded ? 'partial' : 'failed') : 'success', draft_count: targets.length, duration_ms: Date.now() - this.openedAt, succeeded, failed, source: targets[0]?.draft.source || 'manual' })
    if (!updated.some((draft) => draft.status !== 'saved')) {
      wx.disableAlertBeforeUnload?.()
      wx.showToast({
        title: remindersReady ? '已加入库存' : '已入库，部分提醒未开启',
        icon: remindersReady ? 'success' : 'none',
        duration: remindersReady ? 1500 : 2500,
      })
      this.commitDrafts([])
      void this.refreshRecentProfiles()
      this.exitToHome()
    }
  },

  /**
   * 保存成功后逐条预约到期提醒。
   * 微信一次性订阅「一次授权换一条发送额度」，所以只能一件一件申请，攒不成一次批量开通。
   * 用户拒绝（或授权调用失败）就停下、不再连弹；单条挂失败也只跳过这一条——
   * 物品已经入库，提醒始终是附加动作，不影响保存结果。
   */
  async armSavedReminders(targets: Array<{ itemId: string; draft: QuickEntryDraft }>): Promise<boolean> {
    let allReady = true
    for (const { itemId, draft } of targets) {
      if (!itemId) continue
      // 提醒日已经过去（含日期还没落定的草稿）不申请授权，与「完整录入」同一判据。
      const reminder = resolveReminderTime({
        expiryDate: getExpirySummary(draft),
        reminderLeadDays: draft.fields.reminderLeadDays ?? 1,
      })
      if (!reminder || reminder.date < this.data.today) continue
      let accepted = false
      try {
        accepted = await requestReminderAuthorization()
      } catch (_error) {
        accepted = false
      }
      if (!accepted) return false
      try {
        const result = await armReminder(itemId)
        if (result.status === 'missed') allReady = false
      } catch (_error) {
        // 单条挂失败不阻断后面的条目。
        allReady = false
      }
    }
    return allReady
  },
})

function parseLocallySafely(text: string): QuickEntryParseResult['items'] {
  try {
    const result = parseQuickTextLocally(text)
    return Array.isArray(result?.items) ? result.items : []
  } catch (_error) {
    return []
  }
}
