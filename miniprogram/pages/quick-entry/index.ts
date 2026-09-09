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
import { saveItem } from '../../services/inventory-service'
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
import type { QuickEntryDraft, QuickEntryDraftFields, QuickEntryParseResult, QuickEntrySource, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'
import { todayKey } from '../../domain/quick-text'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
const MAX_DRAFTS = 5
/** 最近录入最多展示条目数，超过后不再继续拉取。 */
const MAX_RECENT_PROFILES = 100
let recorderManager: WechatMiniprogram.RecorderManager | null = null
let recorderBound = false
let activePage: any = null
let cancelCurrentRecording = false
let recordingOwner: any = null

function bindRecorder(page: any) {
  activePage = page
  if (recorderBound) return
  recorderManager = wx.getRecorderManager()
  recorderManager.onStop((result: { tempFilePath: string }) => {
    const owner = recordingOwner
    recordingOwner = null
    if (!owner) return
    owner.clearVoiceTimer()
    if (cancelCurrentRecording) {
      cancelCurrentRecording = false
      owner.setData({ voiceState: 'idle', voicePressing: false })
      return
    }
    if (owner === activePage) void owner.handleRecordedFile(result.tempFilePath)
  })
  recorderManager.onError(() => {
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

Page({
  data: {
    today: todayKey(),
    focusNameId: '',
    voiceSeconds: 0,
    voiceCancelling: false,
    photoTargetId: '',
    photoStage: 'idle' as 'idle' | 'camera' | 'preview',
    cameraError: false,
    loading: true,
    loadingError: '',
    inputError: '',
    inputText: '',
    activeTab: 'quick' as 'quick' | 'full',
    quickTab: 'text' as 'text' | 'recent',
    fullMounted: false,
    popup: 'none' as 'none' | 'recent',
    recentLimit: MAX_RECENT_PROFILES,
    recentProfiles: [] as RecentItemProfile[],
    drafts: [] as QuickEntryDraft[],
    draftSummaries: [] as string[],
    expirySummaries: [] as string[],
    expiredFlags: [] as boolean[],
    categoryOptions: FORM_CATEGORY_OPTIONS,
    shelfLifeOptions: SHELF_LIFE_OPTIONS,
    features: QUICK_ENTRY_FEATURES,
    capabilities: { text: true, voice: false, datePhoto: false },
    defaultReminderLeadDays: 1,
    recognitionState: 'idle' as 'idle' | 'parsing' | 'transcribing' | 'recognizing_photo',
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
  voiceBounds: null as { left: number; right: number; top: number; bottom: number } | null,

  onShow() {
    this.manualHandoff = false
    wx.setNavigationBarTitle({ title: '物品录入' })
    if (this.exitOnShow) { wx.disableAlertBeforeUnload?.(); wx.navigateBack(); return }
    activePage = this
    this.setData({ today: todayKey() })
    this.syncUnloadPrompt()
  },

  onHide() { this.cancelVoice() },

  cancelRecognition() {
    if (this.data.recognitionState !== 'idle') wx.hideLoading?.()
    this.recognitionId += 1
    this.pendingRecognition = false
    this.setData({ recognitionState: 'idle', voiceState: 'idle' })
  },

  async preparePage() {
    const [recentResult, capabilityResult, settingsResult] = await Promise.allSettled([
      QUICK_ENTRY_FEATURES.recent ? listRecentProfiles(MAX_RECENT_PROFILES) : Promise.resolve({ items: [] }),
      getQuickEntryCapabilities(),
      getSettings(),
    ])
    const recentProfiles = (recentResult.status === 'fulfilled' ? recentResult.value.items : []).slice(0, MAX_RECENT_PROFILES)
    const capabilities = capabilityResult.status === 'fulfilled'
      ? capabilityResult.value
      : { text: false, voice: false, datePhoto: false }
    const features = QUICK_ENTRY_FEATURES
    const defaultReminderLeadDays = settingsResult.status === 'fulfilled'
      ? settingsResult.value.defaultReminderLeadDays
      : 1
    const loadingError = recentResult.status === 'rejected'
      ? recentResult.reason instanceof CloudServiceError && recentResult.reason.code === 'INVALID_ACTION'
        ? '快速录入服务尚未更新，请先使用完整填写'
        : '最近物品暂时不可用，可重试或直接完整填写'
      : ''
    this.setData({ loading: false, recentProfiles, features, capabilities: { ...capabilities, text: true }, defaultReminderLeadDays, loadingError })
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
      this.setData({ activeTab: 'quick' })
    }
  },

  openFullTab() {
    this.cancelVoice()
    this.cancelRecognition()
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

  switchQuickTab(event: WechatMiniprogram.BaseEvent) {
    const tab = event.currentTarget.dataset.tab
    if ((tab !== 'text' && tab !== 'recent') || tab === this.data.quickTab || this.data.saving) return
    this.cancelVoice()
    this.cancelRecognition()
    this.setData({ quickTab: tab, photoStage: 'idle', photoPreview: '', photoTargetId: '', cameraError: false })
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

  commitDrafts(drafts: QuickEntryDraft[]) {
    const selectableCount = drafts.filter((draft) => draft.selected && !draft.issues.length && draft.status === 'savable').length
    const today = this.data.today
    this.setData({
      drafts,
      draftSummaries: drafts.map(getDraftSummary),
      expirySummaries: drafts.map(getExpirySummary),
      expiredFlags: drafts.map((draft) => {
        const summary = getExpirySummary(draft)
        return /^\d{4}-\d{2}-\d{2}$/.test(summary) ? summary < today : false
      }),
      selectableCount,
    }, () => this.syncUnloadPrompt())
  },

  syncUnloadPrompt() {
    if (this.manualHandoff) return
    const shouldWarn = Boolean(this.data.inputText.trim() || this.data.photoPreview || this.data.drafts.some((draft) => draft.status !== 'saved'))
    if (shouldWarn) wx.enableAlertBeforeUnload?.({ message: '放弃本次录入？' })
    else wx.disableAlertBeforeUnload?.()
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
    if (this.data.drafts.some(draft => draft.status !== 'saved')) {
      const replace = await new Promise<boolean>(resolve => wx.showModal({ title: '重新生成草稿？', content: '当前未保存草稿将被替换，原文仍会保留。', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!replace) return
    }
    const recognitionId = ++this.recognitionId
    this.pendingRecognition = true
    this.setData({ recognitionState: 'parsing', inputError: '' })
    const startedAt = Date.now()
    wx.showLoading?.({ title: '正在生成…', mask: true })
    try {
      const built = await this.buildDraftsFromText(text, source)
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', saveSummary: '', inputError: built.notice })
      this.commitDrafts(built.drafts)
      this.setData({ focusNameId: built.drafts.find(draft => !draft.fields.name)?.draftId || '' })
      track('quick_parse_result', { result: built.notice ? 'fallback' : 'success', durationMs: Date.now() - startedAt, draftCount: built.drafts.length })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('quick_parse_result', { result: 'failed', durationMs: Date.now() - startedAt, failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    } finally {
      if (recognitionId === this.recognitionId) {
        wx.hideLoading?.()
        this.pendingRecognition = false
        this.setData({ recognitionState: 'idle', voiceState: 'idle' })
      }
    }
  },

  /** 云端优先，失败或结果为空时退到本地解析；仍识别不出时产出一条可手填的草稿。 */
  async buildDraftsFromText(text: string, source: Extract<QuickEntrySource, 'text' | 'voice'>): Promise<{ drafts: QuickEntryDraft[]; notice: string }> {
    const items = await this.recognizeTextItems(text)
    if (!items.length) {
      const draft = createDraftFromParsed(
        { name: fallbackDraftName(text), dateCandidates: [] },
        source,
        this.data.defaultReminderLeadDays,
        undefined,
        { kind: 'text', sourceText: text },
      )
      return { drafts: [draft], notice: '没识别出明确信息，已生成一条草稿，补全名称和日期即可保存' }
    }
    const drafts = items.map((item) => {
      const itemName = typeof item.name === 'string' ? normalizeRecentName(item.name) : ''
      const recent = itemName ? this.data.recentProfiles.find((profile) => normalizeRecentName(profile.name) === itemName) : undefined
      return createDraftFromParsed(item, source, this.data.defaultReminderLeadDays, recent, { kind: 'text', sourceText: text })
    })
    return { drafts, notice: '' }
  },

  async recognizeTextItems(text: string) {
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
      if (items.length) return items
    } catch (error) {
      if (!(error instanceof CloudServiceError)) {
        const local = parseLocallySafely(text)
        if (local.length) return local
        throw error
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    return parseLocallySafely(text)
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
    this.updateDraft(index, (draft) => ({
      ...draft,
      confirmationFields: (draft.confirmationFields || []).filter((item) => item !== field),
      fields: { ...draft.fields, [field]: value },
    }))
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
    const drafts = this.data.drafts.filter((_draft, index) => index !== Number(event.currentTarget.dataset.index))
    this.commitDrafts(drafts)
  },

  async startVoice() {
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
      this.clearVoiceTimer()
      this.voiceTimer = setInterval(() => this.setData({ voiceSeconds: Math.min(30, this.data.voiceSeconds + 1) }), 1000)
    } catch (_error) {
      this.setData({ voiceState: 'idle', voicePressing: false, inputError: '需要麦克风权限才能录音，也可以继续使用文字或完整填写' })
      track('voice_permission_result', { result: 'denied' })
      wx.showModal({ title: '麦克风权限未开启', content: '麦克风只用于本次语音录入，可在设置中开启。', confirmText: '去设置', success: (result) => { if (result.confirm) wx.openSetting() } })
    }
  },

  stopVoice() {
    this.setData({ voicePressing: false })
    cancelCurrentRecording = this.data.voiceCancelling
    if (this.data.voiceState === 'recording') recorderManager?.stop()
  },

  cancelVoice() {
    this.setData({ voicePressing: false })
    if (this.data.voiceState === 'recording') {
      cancelCurrentRecording = true
      recorderManager?.stop()
    }
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
    if (this.data.saving || this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle') return
    if (!this.data.capabilities.datePhoto) return
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
      this.setData({ recognitionState: 'idle', photoStage: 'idle', photoPreview: '', focusNameId: draft.fields.name ? '' : draft.draftId })
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
