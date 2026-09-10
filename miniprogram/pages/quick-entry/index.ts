import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import {
  assignDateCandidate,
  createDraftFromParsed,
  createDraftFromRecent,
  draftToInventoryInput,
  draftToManualFields,
  getDraftSummary,
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
  recognizeDatePhoto,
  transcribeVoice,
  uploadQuickEntryMedia,
  removeMedia,
} from '../../services/quick-entry-service'
import { getSettings } from '../../services/settings-service'
import type { ShelfLifeUnit } from '../../types/inventory'
import type { QuickEntryCapabilities, QuickEntryDraft, QuickEntryDraftFields, QuickEntryParseResult, QuickEntrySource, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'
import { todayKey } from '../../domain/quick-text'
import { toDayOrdinal } from '../../utils/date-key'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
const MAX_DRAFTS = 5
/** 最近录入最多展示条目数，超过后不再继续拉取。 */
const MAX_RECENT_PROFILES = 100
/** AI 识别超过这个时长就换一句更耐等的文案，别让「AI 识别中…」僵在那儿。 */
const AI_PATIENCE_MS = 3000
let recorderManager: WechatMiniprogram.RecorderManager | null = null
let recorderBound = false
let activePage: any = null
let cancelCurrentRecording = false
let recordingOwner: any = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null

function clearSilenceTimer() {
  if (silenceTimer) clearTimeout(silenceTimer)
  silenceTimer = null
}

function bindRecorder(page: any) {
  activePage = page
  if (recorderBound) return
  recorderManager = wx.getRecorderManager()
  recorderManager.onStop((result: { tempFilePath: string }) => {
    const owner = recordingOwner
    recordingOwner = null
    if (!owner) return
    owner.clearVoiceTimer()
    clearSilenceTimer()
    if (cancelCurrentRecording) {
      cancelCurrentRecording = false
      owner.setData({ voiceState: 'idle', voicePressing: false })
      return
    }
    if (owner === activePage) void owner.handleRecordedFile(result.tempFilePath)
  })
  recorderManager.onError(() => {
    clearSilenceTimer()
    recordingOwner?.clearVoiceTimer()
    recordingOwner = null
    activePage?.setData({ voiceState: 'idle', voicePressing: false, inputError: '录音失败，请重试或改用文字输入' })
  })
  recorderBound = true
}

/** 识别不到结构化结果时的兜底名称，保证用户始终能看到一条可编辑草稿。 */
function fallbackDraftName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40)
}

const SOURCE_LABELS: Record<QuickEntrySource, string> = {
  recent: '最近记录',
  text: '文字识别',
  voice: '语音识别',
  date_photo: '拍照识别',
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

/**
 * 云端没开语音/拍日期能力时按钮会置灰，用户点了没反应会以为坏了，所以给一行静态说明。
 * 不能用 toast：微信标题超过 7 个汉字会被截断，出现过被吐槽的残缺提示。
 */
function unavailableHintsOf(capabilities: QuickEntryCapabilities, reachable: boolean): string[] {
  const features = QUICK_ENTRY_FEATURES
  if (!reachable) {
    return features.voice || features.datePhoto
      ? ['识别服务暂时不可用，可先手动输入或选择日期']
      : []
  }
  const hints: string[] = []
  if (features.voice && !capabilities.voice) hints.push('语音识别暂未接入，可先手动输入')
  if (features.datePhoto && !capabilities.datePhoto) hints.push('拍照识别暂未接入，可先手动选择日期')
  return hints
}

Page({
  data: {
    today: todayKey(),
    voiceSeconds: 0,
    voiceCancelling: false,
    photoTargetId: '',
    photoStage: 'idle' as 'idle' | 'camera' | 'preview',
    cameraError: false,
    loading: true,
    loadingError: '',
    inputError: '',
    inputText: '',
    quickInputFocused: true,
    quickKeyboardHeight: 0,
    activeTab: 'quick' as 'quick' | 'full',
    quickTab: 'text' as 'text' | 'recent',
    fullMounted: false,
    popup: 'none' as 'none' | 'recent',
    recentLimit: MAX_RECENT_PROFILES,
    recentProfiles: [] as RecentItemProfile[],
    drafts: [] as QuickEntryDraft[],
    draftSummaries: [] as string[],
    expirySummaries: [] as string[],
    expiryBadges: [] as string[],
    expiryTones: [] as Array<'fresh' | 'soon' | 'expired' | 'empty'>,
    statusLabels: [] as string[],
    statusTones: [] as string[],
    sourceLabels: [] as string[],
    aiFlags: [] as boolean[],
    aiMissingHints: [] as string[],
    nameMissingFlags: [] as boolean[],
    expiredFlags: [] as boolean[],
    categoryOptions: FORM_CATEGORY_OPTIONS,
    shelfLifeOptions: SHELF_LIFE_OPTIONS,
    features: QUICK_ENTRY_FEATURES,
    capabilities: { text: true, voice: false, datePhoto: false, aiText: false },
    unavailableHints: [] as string[],
    defaultReminderLeadDays: 1,
    recognitionState: 'idle' as 'idle' | 'parsing' | 'transcribing' | 'recognizing_photo',
    recognitionTip: '正在识别…',
    voiceState: 'idle' as 'idle' | 'authorizing' | 'recording' | 'uploading',
    voicePressing: false,
    photoPreview: '',
    saving: false,
    selectableCount: 0,
    saveSummary: '',
  },

  onLoad() {
    this.recognitionId = 0
    this.openedAt = Date.now()
    bindRecorder(this)
    track('quick_entry_open')
    void this.preparePage()
  },

  onUnload() {
    track('quick_entry_session_end', { savedCount: this.savedCount, durationMs: Date.now() - this.openedAt })
    this.cancelVoice()
    this.cancelRecognition()
    this.clearVoiceTimer()
    if (activePage === this) activePage = null
  },

  recognitionId: 0,
  openedAt: 0,
  savedCount: 0,
  manualHandoff: false,
  exitOnShow: false,
  pendingRecognition: false,
  textSession: null as { drafts: QuickEntryDraft[]; inputError: string; saveSummary: string } | null,
  voiceTimer: null as ReturnType<typeof setInterval> | null,
  recognitionTipTimer: null as ReturnType<typeof setTimeout> | null,
  voiceBounds: null as { left: number; right: number; top: number; bottom: number } | null,

  onShow() {
    this.manualHandoff = false
    wx.setNavigationBarTitle({ title: '物品录入' })
    if (this.exitOnShow) { wx.disableAlertBeforeUnload?.(); wx.navigateBack(); return }
    activePage = this
    this.setData({ today: todayKey() })
    this.syncUnloadPrompt()
  },

  onHide() {
    this.cancelVoice()
    this.resetQuickKeyboardHeight()
  },

  cancelRecognition() {
    if (this.data.recognitionState !== 'idle') wx.hideLoading?.()
    this.recognitionId += 1
    this.pendingRecognition = false
    this.clearRecognitionTip()
    this.setData({ recognitionState: 'idle', voiceState: 'idle' })
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
    const recentProfiles = (recentResult.status === 'fulfilled' ? recentResult.value.items : []).slice(0, MAX_RECENT_PROFILES)
    const capabilityReady = capabilityResult.status === 'fulfilled'
    const capabilities = capabilityReady
      ? capabilityResult.value
      : { text: false, voice: false, datePhoto: false, aiText: false }
    const features = QUICK_ENTRY_FEATURES
    const defaultReminderLeadDays = settingsResult.status === 'fulfilled'
      ? settingsResult.value.defaultReminderLeadDays
      : 1
    const loadingError = recentResult.status === 'rejected'
      ? recentResult.reason instanceof CloudServiceError && recentResult.reason.code === 'INVALID_ACTION'
        ? '快速录入服务尚未更新，请先使用完整填写'
        : '最近物品暂时不可用，可重试或直接完整填写'
      : ''
    const normalizedCapabilities = { ...capabilities, text: true, aiText: Boolean(capabilities.aiText) }
    this.setData({
      loading: false,
      recentProfiles,
      features,
      capabilities: normalizedCapabilities,
      unavailableHints: unavailableHintsOf(normalizedCapabilities, capabilityReady),
      defaultReminderLeadDays,
      loadingError,
    })
    if (!recentProfiles.length && !features.text && !features.voice && !features.datePhoto && !loadingError) {
      this.openFullTab()
    }
  },

  async loadRecentProfiles() {
    try {
      const result = await listRecentProfiles(MAX_RECENT_PROFILES)
      this.setData({ loading: false, recentProfiles: result.items.slice(0, MAX_RECENT_PROFILES), loadingError: '' })
    } catch (error) {
      this.setData({
        loading: false,
        loadingError: error instanceof CloudServiceError && error.code === 'INVALID_ACTION'
          ? '快速录入服务尚未更新，请先使用完整填写'
          : '最近物品暂时不可用，可重试或直接完整填写',
      })
    }
  },

  retryRecent() {
    this.setData({ loadingError: '' })
    void this.loadRecentProfiles()
  },

  switchTab(event: WechatMiniprogram.BaseEvent) {
    const tab = event.currentTarget.dataset.tab as 'quick' | 'full'
    if (!tab || tab === this.data.activeTab) return
    if (this.data.saving && tab === 'full') return
    if (tab === 'full') this.openFullTab()
    else {
      this.cancelVoice()
      this.setData({ activeTab: 'quick', quickTab: 'text', quickInputFocused: true })
    }
  },

  openFullTab() {
    this.cancelVoice()
    this.cancelRecognition()
    this.blurQuickInput()
    track('quick_entry_switch_tab', { tab: 'full' })
    this.setData({ activeTab: 'full', fullMounted: true })
  },

  handleFullFormSaved(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as unknown as { restoring: boolean; name: string }
    wx.disableAlertBeforeUnload?.()
    wx.showToast({ title: detail.restoring ? '已重新入库' : '已加入库存', icon: 'success' })
    this.withForm((form) => form.resetEntry())
    void this.loadRecentProfiles()
  },

  /** 组件首次渲染后 selectComponent 才可用，失败时退到下一帧再取一次。 */
  withForm(consumer: (form: any) => void) {
    const form = this.selectComponent?.('#fullForm')
    if (form) {
      consumer(form as any)
      return
    }
    setTimeout(() => {
      const retry = this.selectComponent?.('#fullForm')
      if (retry) consumer(retry as any)
    }, 40)
  },

  openRecentList() {
    if (this.data.saving || this.data.quickTab === 'recent') return
    this.cancelVoice()
    this.cancelRecognition()
    this.blurQuickInput()
    this.setData({ quickTab: 'recent', photoStage: 'idle', photoPreview: '', photoTargetId: '', cameraError: false })
  },

  closeRecentList() {
    if (this.data.saving || this.data.quickTab !== 'recent') return
    this.setData({ quickTab: 'text', quickInputFocused: false })
  },

  closePopup() {
    this.cancelRecognition()
    this.cancelVoice()
    const session = this.textSession
    this.textSession = null
    this.setData({ popup: 'none', inputText: session ? this.data.inputText : '', inputError: session?.inputError || '', saveSummary: session?.saveSummary || '', photoStage: 'idle', photoPreview: '', photoTargetId: '', cameraError: false })
    this.commitDrafts(session?.drafts || [])
  },

  requestClosePopup() {
    if (this.data.saving) return
    this.closePopup()
  },

  /** 卡片展示需要的派生信息，任何一次草稿变更都要走这里，避免视图与数据脱节。 */
  draftView(drafts: QuickEntryDraft[]) {
    const today = this.data.today
    const summaries = drafts.map(getExpirySummary)
    return {
      draftSummaries: drafts.map(getDraftSummary),
      expirySummaries: summaries,
      expiryBadges: summaries.map(summary => expiryBadgeText(summary, today)),
      expiryTones: summaries.map(summary => expiryToneOf(summary, today)),
      expiredFlags: summaries.map(summary => expiryToneOf(summary, today) === 'expired'),
      statusLabels: drafts.map(draft => statusMeta(draft).label),
      statusTones: drafts.map(draft => statusMeta(draft).tone),
      sourceLabels: drafts.map(draft => SOURCE_LABELS[draft.source] || '录入'),
      aiFlags: drafts.map(draft => Boolean(draft.parserVersion?.startsWith('ai-'))),
      aiMissingHints: drafts.map(aiMissingHint),
      nameMissingFlags: drafts.map(draft => draft.issues.some(issue => issue.field === 'name')),
    }
  },

  commitDrafts(drafts: QuickEntryDraft[]) {
    this.setData({
      drafts,
      ...this.draftView(drafts),
      selectableCount: countSelectable(drafts),
    }, () => this.syncUnloadPrompt())
  },

  syncUnloadPrompt() {
    if (this.manualHandoff) return
    const shouldWarn = Boolean(this.data.inputText.trim() || this.data.photoPreview || this.data.drafts.some((draft) => draft.status !== 'saved'))
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
    if (this.data.recognitionState === 'parsing' || this.data.recognitionState === 'transcribing') this.cancelRecognition()
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

  async generateDrafts(sourceOrEvent: Extract<QuickEntrySource, 'text' | 'voice'> | WechatMiniprogram.BaseEvent = 'text') {
    const source: Extract<QuickEntrySource, 'text' | 'voice'> = sourceOrEvent === 'voice' ? 'voice' : 'text'
    const text = this.data.inputText.trim()
    if (!text) {
      this.setData({ inputError: '请输入物品和日期' })
      return
    }
    if (this.pendingRecognition || this.data.saving) return
    // 上一次识别异常中断留下状态时再点会完全没反应，这里先自愈。
    if (this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle') this.cancelRecognition()
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
      this.commitDrafts([...existing, ...built.drafts])
      track('quick_parse_result', { result: built.notice ? 'fallback' : 'success', durationMs: Date.now() - startedAt, draftCount: built.drafts.length })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('quick_parse_result', { result: 'failed', durationMs: Date.now() - startedAt, failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    } finally {
      if (recognitionId === this.recognitionId) {
        wx.hideLoading?.()
        this.pendingRecognition = false
        this.clearRecognitionTip()
        this.setData({ recognitionState: 'idle', voiceState: 'idle' })
      }
    }
  },

  /** 云端优先，失败或结果为空时退到本地解析；仍识别不出时产出一条可手填的草稿。 */
  async buildDraftsFromText(text: string, source: Extract<QuickEntrySource, 'text' | 'voice'>): Promise<{ drafts: QuickEntryDraft[]; notice: string }> {
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

  selectRecent(event: WechatMiniprogram.CustomEvent) {
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    const profile = this.data.recentProfiles[Number(event.currentTarget.dataset.index)]
    if (!profile) return
    const pending = this.data.popup === 'recent' ? this.data.drafts.filter((draft) => draft.status !== 'saved') : []
    if (pending.length >= MAX_DRAFTS) {
      this.setData({ inputError: `一次最多 ${MAX_DRAFTS} 条草稿，请先处理当前草稿` })
      return
    }
    const draft = createDraftFromRecent(profile, this.data.defaultReminderLeadDays)
    if (this.data.popup !== 'recent') {
      this.textSession = { drafts: this.data.drafts, inputError: this.data.inputError, saveSummary: this.data.saveSummary }
    }
    track('recent_item_select')
    this.setData({ popup: 'recent', saveSummary: '', inputError: '', photoStage: 'idle', photoPreview: '', photoTargetId: '' }, () => {
      this.commitDrafts([...pending, draft])
    })
  },

  updateDraft(index: number, mutator: (draft: QuickEntryDraft) => QuickEntryDraft) {
    const current = this.data.drafts[index]
    if (this.data.saving || !current || ['saving', 'saved', 'failed'].includes(current.status)) return
    const drafts = [...this.data.drafts]
    drafts[index] = refreshDraftValidation(mutator(current))
    this.commitDrafts(drafts)
  },

  handleTextInput(event: WechatMiniprogram.Input) {
    const index = Number(event.currentTarget.dataset.index)
    const field = event.currentTarget.dataset.field as keyof Pick<QuickEntryDraftFields, 'name' | 'quantity' | 'unit' | 'storageLocation' | 'shelfLifeValue' | 'reminderLeadDays'>
    const rawValue = event.detail.value
    const value = ['quantity', 'shelfLifeValue', 'reminderLeadDays'].includes(field) ? (rawValue ? Number(rawValue) : null) : rawValue
    const draft = this.data.drafts[index]
    if (this.data.saving || !draft || ['saving', 'saved', 'failed'].includes(draft.status)) return
    const nextDraft = refreshDraftValidation({
      ...draft,
      confirmationFields: (draft.confirmationFields || []).filter((item) => item !== field),
      aiMissingFields: (draft.aiMissingFields || []).filter((item) => item !== field),
      fields: { ...draft.fields, [field]: value },
    })
    const drafts = [...this.data.drafts]
    drafts[index] = nextDraft
    const summary = getExpirySummary(nextDraft)
    const status = statusMeta(nextDraft)
    this.setData({
      [`drafts[${index}]`]: nextDraft,
      [`draftSummaries[${index}]`]: getDraftSummary(nextDraft),
      [`expirySummaries[${index}]`]: summary,
      [`expiryBadges[${index}]`]: expiryBadgeText(summary, this.data.today),
      [`expiryTones[${index}]`]: expiryToneOf(summary, this.data.today),
      [`expiredFlags[${index}]`]: expiryToneOf(summary, this.data.today) === 'expired',
      [`statusLabels[${index}]`]: status.label,
      [`statusTones[${index}]`]: status.tone,
      [`aiMissingHints[${index}]`]: aiMissingHint(nextDraft),
      [`nameMissingFlags[${index}]`]: nextDraft.issues.some(issue => issue.field === 'name'),
      selectableCount: countSelectable(drafts),
    }, () => this.syncUnloadPrompt())
    track('draft_field_corrected', { field })
  },

  handleCategoryChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.currentTarget.dataset.index)
    const category = FORM_CATEGORY_OPTIONS[Number(event.detail.value)]?.value
    if (!category) return
    this.updateDraft(index, (draft) => ({ ...draft, confirmationFields: (draft.confirmationFields || []).filter((field) => field !== 'category'), fields: { ...draft.fields, category } }))
  },

  handleShelfLifeUnitChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.currentTarget.dataset.index)
    const shelfLifeUnit = SHELF_LIFE_OPTIONS[Number(event.detail.value)]?.value as ShelfLifeUnit | undefined
    if (!shelfLifeUnit) return
    this.updateDraft(index, (draft) => ({ ...draft, confirmationFields: (draft.confirmationFields || []).filter((field) => field !== 'shelfLifeUnit'), fields: { ...draft.fields, shelfLifeUnit } }))
  },

  handleDateChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.currentTarget.dataset.index)
    const field = event.currentTarget.dataset.field as 'expiryDate' | 'productionDate'
    this.updateDraft(index, (draft) => ({ ...draft, dateInvalid: false, dateConflict: undefined,
      confirmationFields: (draft.confirmationFields || []).filter(item => !item.startsWith('date:')),
      fields: { ...draft.fields, [field]: String(event.detail.value), ...(field === 'expiryDate' ? { productionDate: null } : {}) } }))
    track('draft_field_corrected', { field })
  },

  handleModeChange(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const mode = event.currentTarget.dataset.mode as QuickEntryDraftFields['expiryInputMode']
    this.updateDraft(index, (draft) => ({
      ...draft,
      fields: { ...draft.fields, expiryInputMode: mode, expiryDate: mode === 'direct' ? draft.fields.expiryDate : null, productionDate: mode === 'shelf_life' ? draft.fields.productionDate : null },
    }))
  },

  chooseCandidate(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const candidateIndex = Number(event.currentTarget.dataset.candidate)
    const role = event.currentTarget.dataset.role as 'expiry' | 'production'
    this.updateDraft(index, (draft) => assignDateCandidate(draft, candidateIndex, role))
  },

  toggleSelected(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateDraft(index, (draft) => ({ ...draft, selected: !draft.selected }))
  },

  toggleDetails(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateDraft(index, (draft) => ({ ...draft, expanded: !draft.expanded }))
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

  async startVoice() {
    // 未接入语音能力时静默返回，避免弹出体验很差的权限框或 toast。
    if (!this.data.capabilities.voice) return
    if (this.data.saving || this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle') return
    this.setData({ voicePressing: true, voiceState: 'authorizing', inputError: '' })
    try {
      await new Promise<void>((resolve, reject) => wx.authorize({ scope: 'scope.record', success: () => resolve(), fail: reject }))
      track('voice_permission_result', { result: 'granted' })
      if (!this.data.voicePressing) {
        this.setData({ voiceState: 'idle' })
        return
      }
      cancelCurrentRecording = false
      recordingOwner = this
      this.createSelectorQuery().select('.voice-button').boundingClientRect(rect => { if (rect && !Array.isArray(rect)) this.voiceBounds = rect }).exec()
      recorderManager?.start({ duration: 30000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' })
      this.setData({ voiceState: 'recording', voiceSeconds: 0, voiceCancelling: false })
      clearSilenceTimer()
      silenceTimer = setTimeout(() => {
        if (recordingOwner === this && this.data.voiceState === 'recording') {
          this.setData({ inputError: '暂未听到语音，已自动停止，请靠近麦克风重试' })
          recorderManager?.stop()
        }
      }, 5000)
      this.clearVoiceTimer()
      this.voiceTimer = setInterval(() => this.setData({ voiceSeconds: Math.min(30, this.data.voiceSeconds + 1) }), 1000)
    } catch (_error) {
      this.setData({ voiceState: 'idle', voicePressing: false, inputError: '需要麦克风权限才能录音，也可以继续使用文字或完整填写' })
      track('voice_permission_result', { result: 'denied' })
      wx.showModal({ title: '麦克风权限未开启', content: '麦克风只用于本次语音录入，可在设置中开启。', confirmText: '去设置', success: (result) => { if (result.confirm) wx.openSetting() } })
    }
  },

  stopVoice() {
    clearSilenceTimer()
    this.setData({ voicePressing: false })
    cancelCurrentRecording = this.data.voiceCancelling
    if (this.data.voiceState === 'recording') recorderManager?.stop()
  },

  cancelVoice() {
    clearSilenceTimer()
    this.setData({ voicePressing: false })
    if (this.data.voiceState === 'recording') {
      cancelCurrentRecording = true
      recorderManager?.stop()
    }
  },

  toggleVoice() {
    if (this.data.voiceState === 'recording') this.stopVoice()
    else void this.startVoice()
  },

  moveVoice(event: WechatMiniprogram.TouchEvent) {
    const touch = event.touches[0]
    const rect = this.voiceBounds
    if (!touch || !rect || this.data.voiceState !== 'recording') return
    this.setData({ voiceCancelling: touch.clientX < rect.left || touch.clientX > rect.right || touch.clientY < rect.top || touch.clientY > rect.bottom })
  },

  clearVoiceTimer() {
    if (this.voiceTimer) clearInterval(this.voiceTimer)
    this.voiceTimer = null
  },

  async handleRecordedFile(localPath: string) {
    const recognitionId = ++this.recognitionId
    this.setData({ voiceState: 'uploading', recognitionState: 'transcribing', inputError: '' })
    try {
      const fileID = await uploadQuickEntryMedia(localPath, 'audio')
      if (recognitionId !== this.recognitionId) { await removeMedia(fileID); return }
      const result = await transcribeVoice(fileID, 'audio')
      if (recognitionId !== this.recognitionId) return
      this.setData({ inputText: result.text, voiceState: 'idle', recognitionState: 'idle' })
      track('voice_transcribe_result', { result: 'success' })
      await this.generateDrafts('voice')
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ voiceState: 'idle', recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('voice_transcribe_result', { result: 'failed', failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  chooseDatePhoto(event?: WechatMiniprogram.BaseEvent) {
    // 未接入拍日期能力时静默返回，按钮在页面上已经是置灰状态。
    if (!this.data.capabilities.datePhoto) return
    if (this.data.saving || this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle') return
    if (this.data.photoStage !== 'idle') {
      this.closePhoto()
      return
    }
    const index = event?.currentTarget?.dataset?.index
    const target = index == null ? undefined : this.data.drafts[Number(index)]
    if (target && ['saved', 'saving', 'failed'].includes(target.status)) return
    if (!target && this.data.drafts.length >= MAX_DRAFTS) {
      this.setData({ inputError: `一次最多 ${MAX_DRAFTS} 条草稿，请先处理当前草稿` })
      return
    }
    this.setData({ photoTargetId: target?.draftId || '', photoStage: 'camera', photoPreview: '', cameraError: false, inputError: '' })
  },

  cameraFailed() {
    this.setData({ cameraError: true, inputError: '相机不可用，可在设置中允许本次日期拍摄，或从相册选择、手动填写' })
  },

  openPermissionSettings() { wx.openSetting() },

  takeDatePhoto() {
    wx.createCameraContext().takePhoto({
      quality: 'normal',
      success: result => this.setData({ photoPreview: result.tempImagePath, photoStage: 'preview' }, () => this.syncUnloadPrompt()),
      fail: () => this.cameraFailed(),
    })
  },

  retakePhoto() { this.setData({ photoStage: 'camera', cameraError: false }) },

  closePhoto() {
    this.cancelRecognition()
    this.setData({ photoStage: 'idle' })
  },

  async chooseAlbum() {
    try {
      const media = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) =>
        wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], success: resolve, fail: reject }))
      const localPath = media.tempFiles[0]?.tempFilePath
      if (localPath) this.setData({ photoPreview: localPath, photoStage: 'preview', inputError: '' }, () => this.syncUnloadPrompt())
    } catch (error) {
      if (!String((error as { errMsg?: string }).errMsg || '').includes('cancel')) {
        this.setData({ inputError: '相册暂不可用，请检查权限，或继续手动填写日期' })
      }
    }
  },

  async recognizePhoto() {
    const localPath = this.data.photoPreview
    if (!localPath || this.data.saving || this.data.recognitionState !== 'idle') return
    const recognitionId = ++this.recognitionId
    const targetId = this.data.photoTargetId
    this.setData({ recognitionState: 'recognizing_photo', inputError: '' })
    wx.showLoading?.({ title: '正在识别日期…', mask: true })
    try {
      const fileID = await uploadQuickEntryMedia(localPath, 'image')
      if (recognitionId !== this.recognitionId) { await removeMedia(fileID); return }
      const result = await recognizeDatePhoto(fileID, 'image')
      if (recognitionId !== this.recognitionId) return
      wx.hideLoading?.()
      if (result.unsupported === 'opened_period') {
        this.setData({ recognitionState: 'idle', inputError: '当前版本暂不支持“开封后使用期”，请手动选择日期' })
        return
      }
      const current = this.data.drafts.find(draft => draft.draftId === targetId)
      if (targetId && (!current || ['saved', 'saving', 'failed'].includes(current.status))) {
        this.setData({ recognitionState: 'idle', inputError: '原草稿已变化，请重新选择要补充日期的草稿' })
        return
      }
      const draft = createDraftFromParsed({
        ...(current ? {
          name: current.fields.name, quantity: current.fields.quantity ?? undefined,
          unit: current.fields.unit, category: current.fields.category || undefined,
          storageLocation: current.fields.storageLocation,
        } : {}),
        shelfLifeValue: result.shelfLifeValue ?? current?.fields.shelfLifeValue ?? undefined,
        shelfLifeUnit: result.shelfLifeUnit ?? current?.fields.shelfLifeUnit ?? undefined,
        dateCandidates: result.candidates,
      }, 'date_photo', current?.fields.reminderLeadDays ?? this.data.defaultReminderLeadDays,
      undefined, { kind: 'photo', localPath, sourceText: result.sourceText })
      if (current) {
        draft.draftId = current.draftId
        draft.saveKey = current.saveKey
        draft.confirmationFields = [...new Set([...(draft.confirmationFields || []), ...(current.confirmationFields || []).filter(field => !field.startsWith('date:'))])]
      }
      const drafts = current ? this.data.drafts.map(item => item.draftId === targetId ? refreshDraftValidation(draft) : item) : [...this.data.drafts, draft]
      this.setData({ recognitionState: 'idle', photoStage: 'idle', photoPreview: '' })
      this.commitDrafts(drafts)
      track('date_photo_result', { result: 'success', candidateCount: result.candidates.length })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('date_photo_result', { result: 'failed' })
    } finally {
      wx.hideLoading?.()
    }
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
    this.setData({ activeTab: 'full', fullMounted: true, popup: 'none', inputText: '', photoPreview: '', photoStage: 'idle', inputError: '' }, () => {
      this.withForm((form) => form.applyPrefill(draft ? draftToManualFields(draft) : null, draft?.saveKey || ''))
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

  confirmFallback(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset.index)
    this.updateDraft(index, draft => ({ ...draft, confirmationFields: (draft.confirmationFields || []).filter(field => field.startsWith('date:')) }))
  },

  async saveDrafts() {
    if (this.data.saving || this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle') return
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
    results.forEach((result, resultIndex) => {
      const target = targets[resultIndex]
      if (result.status === 'fulfilled') {
        updated[target.index] = { ...target.draft, status: 'saved', selected: false, evidence: undefined }
        succeeded += 1
      } else {
        updated[target.index] = { ...target.draft, status: 'failed', selected: false, errorMessage: getErrorMessage(result.reason) }
        failed += 1
      }
    })
    this.setData({ saving: false, saveSummary: failed ? `已成功 ${succeeded} 条，失败 ${failed} 条` : '' })
    this.savedCount += succeeded
    this.commitDrafts(updated)
    const savedItemIds = results
      .map((result) => (result.status === 'fulfilled' ? result.value.itemId : ''))
      .filter(Boolean)
    if (savedItemIds.length) void this.requestCovers(savedItemIds)
    track('quick_entry_save_result', { result: failed ? (succeeded ? 'partial' : 'failed') : 'success', draftCount: targets.length, durationMs: Date.now() - this.openedAt, succeeded, failed, source: targets[0]?.draft.source || 'manual' })
    if (!updated.some((draft) => draft.status !== 'saved')) {
      wx.disableAlertBeforeUnload?.()
      wx.showToast({ title: '已加入库存', icon: 'success' })
      this.closePopup()
      void this.loadRecentProfiles()
    }
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
