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
import type { QuickEntryDraft, QuickEntryDraftFields, QuickEntrySource, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'
import { todayKey } from '../../domain/quick-text'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
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
    recentProfiles: [] as RecentItemProfile[],
    drafts: [] as QuickEntryDraft[],
    draftSummaries: [] as string[],
    expirySummaries: [] as string[],
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
  voiceTimer: null as ReturnType<typeof setInterval> | null,
  voiceBounds: null as { left: number; right: number; top: number; bottom: number } | null,

  onShow() {
    this.manualHandoff = false
    if (this.exitOnShow) { wx.disableAlertBeforeUnload?.(); wx.navigateBack(); return }
    activePage = this
    this.setData({ today: todayKey() })
    this.syncUnloadPrompt()
  },

  onHide() { this.cancelVoice() },

  cancelRecognition() {
    this.recognitionId += 1
    this.setData({ recognitionState: 'idle', voiceState: 'idle' })
  },

  async preparePage() {
    const [recentResult, capabilityResult, settingsResult] = await Promise.allSettled([
      QUICK_ENTRY_FEATURES.recent ? listRecentProfiles() : Promise.resolve({ items: [] }),
      getQuickEntryCapabilities(),
      getSettings(),
    ])
    const recentProfiles = recentResult.status === 'fulfilled' ? recentResult.value.items : []
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
    if (!recentProfiles.length && !features.text && !features.voice && !features.datePhoto && !loadingError) {
      this.openManual()
      return
    }
    this.setData({ loading: false, recentProfiles, features, capabilities: { ...capabilities, text: true }, defaultReminderLeadDays, loadingError })
  },

  async loadRecentProfiles() {
    try {
      const result = await listRecentProfiles()
      this.setData({ loading: false, recentProfiles: result.items, loadingError: '' })
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

  commitDrafts(drafts: QuickEntryDraft[]) {
    const selectableCount = drafts.filter((draft) => draft.selected && !draft.issues.length && draft.status === 'savable').length
    this.setData({
      drafts,
      draftSummaries: drafts.map(getDraftSummary),
      expirySummaries: drafts.map(getExpirySummary),
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
    if (this.data.recognitionState === 'parsing' || this.data.recognitionState === 'transcribing') this.cancelRecognition()
    this.setData({ inputText: event.detail.value, inputError: '' }, () => this.syncUnloadPrompt())
  },

  async generateDrafts(sourceOrEvent: Extract<QuickEntrySource, 'text' | 'voice'> | WechatMiniprogram.BaseEvent = 'text') {
    const source: Extract<QuickEntrySource, 'text' | 'voice'> = sourceOrEvent === 'voice' ? 'voice' : 'text'
    const text = this.data.inputText.trim()
    if (!text) {
      this.setData({ inputError: '请输入物品和日期' })
      return
    }
    if (this.data.recognitionState !== 'idle' || this.data.voiceState !== 'idle' || this.data.saving) return
    if (this.data.drafts.some(draft => draft.status !== 'saved')) {
      const replace = await new Promise<boolean>(resolve => wx.showModal({ title: '重新生成草稿？', content: '当前未保存草稿将被替换，原文仍会保留。', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!replace) return
    }
    const recognitionId = ++this.recognitionId
    this.setData({ recognitionState: 'parsing', inputError: '' })
    const startedAt = Date.now()
    try {
      const result = await parseQuickText(text)
      if (recognitionId !== this.recognitionId) return
      const drafts = result.items.map((item) => {
        const itemName = typeof item.name === 'string' ? normalizeRecentName(item.name) : ''
        const recent = itemName ? this.data.recentProfiles.find((profile) => normalizeRecentName(profile.name) === itemName) : undefined
        return createDraftFromParsed(item, source, this.data.defaultReminderLeadDays, recent, { kind: 'text', sourceText: text })
      })
      this.setData({ recognitionState: 'idle', saveSummary: '' })
      this.commitDrafts(drafts)
      this.setData({ focusNameId: drafts.find(draft => !draft.fields.name)?.draftId || '' })
      track('quick_parse_result', { result: 'success', durationMs: Date.now() - startedAt, draftCount: drafts.length })
      wx.pageScrollTo({ selector: '#draft-area', duration: 220 })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('quick_parse_result', { result: 'failed', durationMs: Date.now() - startedAt, failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  selectRecent(event: WechatMiniprogram.CustomEvent) {
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    const profile = this.data.recentProfiles[Number(event.currentTarget.dataset.index)]
    if (!profile) return
    const draft = createDraftFromRecent(profile, this.data.defaultReminderLeadDays)
    this.setData({ saveSummary: '' })
    this.commitDrafts([draft])
    track('recent_item_select')
    wx.pageScrollTo({ selector: '#draft-date-0', duration: 220 })
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
    const index = event?.currentTarget?.dataset?.index
    const target = index == null ? undefined : this.data.drafts[Number(index)]
    if (target && ['saved', 'saving', 'failed'].includes(target.status)) return
    if (!target && this.data.drafts.length >= 5) {
      this.setData({ inputError: '一次最多 5 条草稿，请先处理当前草稿' })
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
    try {
      const fileID = await uploadQuickEntryMedia(localPath, 'image')
      if (recognitionId !== this.recognitionId) { await removeMedia(fileID); return }
      const result = await recognizeDatePhoto(fileID, 'image')
      if (recognitionId !== this.recognitionId) return
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
      wx.pageScrollTo({ selector: '#draft-area', duration: 220 })
    } catch (error) {
      if (recognitionId !== this.recognitionId) return
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('date_photo_result', { result: 'failed' })
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
    getApp<IAppOption>().globalData.pendingQuickFormDraft = draft ? draftToManualFields(draft) : null
    track('quick_entry_manual', { source: draft?.source || 'manual' })
    this.manualHandoff = true
    wx.disableAlertBeforeUnload?.()
    wx.navigateTo({
      url: '/pages/item-form/index?source=quick-entry',
      success: result => {
        result.eventChannel.emit('quickDraftIdentity', { saveKey: draft?.saveKey })
        result.eventChannel.on('quickDraftSaved', () => {
          this.savedCount += 1
          if (draft) this.commitDrafts(this.data.drafts.map(item => item.draftId === draft.draftId ? { ...item, status: 'saved', selected: false, evidence: undefined } : item))
          if (!this.data.drafts.some(item => item.status !== 'saved')) {
            this.exitOnShow = true
            this.setData({ inputText: '', photoPreview: '' }, () => this.syncUnloadPrompt())
          }
        })
      },
      fail: () => { getApp<IAppOption>().globalData.pendingQuickFormDraft = null; this.manualHandoff = false; this.syncUnloadPrompt() },
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
      wx.navigateBack()
    }
  },

  openManual() {
    wx.disableAlertBeforeUnload?.()
    wx.redirectTo({ url: '/pages/item-form/index' })
  },
})
