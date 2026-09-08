import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import {
  assignDateCandidate,
  createDraftFromParsed,
  createDraftFromRecent,
  draftToInventoryInput,
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
} from '../../services/quick-entry-service'
import { getSettings } from '../../services/settings-service'
import type { InventorySaveInput, ShelfLifeUnit } from '../../types/inventory'
import type { QuickEntryDraft, QuickEntryDraftFields, QuickEntrySource, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
let recorderManager: WechatMiniprogram.RecorderManager | null = null
let recorderBound = false
let activePage: any = null
let cancelCurrentRecording = false

function bindRecorder(page: any) {
  activePage = page
  if (recorderBound) return
  recorderManager = wx.getRecorderManager()
  recorderManager.onStop((result: { tempFilePath: string }) => {
    if (!activePage) return
    if (cancelCurrentRecording) {
      cancelCurrentRecording = false
      activePage.setData({ voiceState: 'idle', voicePressing: false })
      return
    }
    void activePage.handleRecordedFile(result.tempFilePath)
  })
  recorderManager.onError(() => {
    activePage?.setData({ voiceState: 'idle', voicePressing: false, inputError: '录音失败，请重试或改用文字输入' })
  })
  recorderBound = true
}

Page({
  data: {
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
    features: { recent: QUICK_ENTRY_FEATURES.recent, text: false, voice: false, datePhoto: false },
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
    bindRecorder(this)
    track('quick_entry_open')
    void this.preparePage()
  },

  onUnload() {
    if (activePage === this) activePage = null
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
    const features = {
      recent: QUICK_ENTRY_FEATURES.recent,
      text: QUICK_ENTRY_FEATURES.text && capabilities.text,
      voice: QUICK_ENTRY_FEATURES.voice && capabilities.voice,
      datePhoto: QUICK_ENTRY_FEATURES.datePhoto && capabilities.datePhoto,
    }
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
    this.setData({ loading: false, recentProfiles, features, defaultReminderLeadDays, loadingError })
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
    const selectableCount = drafts.filter((draft) => draft.selected && !draft.issues.length && ['savable', 'failed'].includes(draft.status)).length
    this.setData({
      drafts,
      draftSummaries: drafts.map(getDraftSummary),
      expirySummaries: drafts.map(getExpirySummary),
      selectableCount,
    }, () => this.syncUnloadPrompt())
  },

  syncUnloadPrompt() {
    const shouldWarn = Boolean(this.data.inputText.trim() || this.data.photoPreview || this.data.drafts.some((draft) => draft.status !== 'saved'))
    if (shouldWarn) wx.enableAlertBeforeUnload?.({ message: '放弃本次录入？' })
    else wx.disableAlertBeforeUnload?.()
  },

  handleQuickTextInput(event: WechatMiniprogram.Input) {
    this.setData({ inputText: event.detail.value, inputError: '' }, () => this.syncUnloadPrompt())
  },

  async generateDrafts(sourceOrEvent: Extract<QuickEntrySource, 'text' | 'voice'> | WechatMiniprogram.BaseEvent = 'text') {
    const source: Extract<QuickEntrySource, 'text' | 'voice'> = sourceOrEvent === 'voice' ? 'voice' : 'text'
    const text = this.data.inputText.trim()
    if (!text) {
      this.setData({ inputError: '请输入物品和日期' })
      return
    }
    if (this.data.recognitionState !== 'idle' || this.data.saving) return
    this.setData({ recognitionState: 'parsing', inputError: '' })
    const startedAt = Date.now()
    try {
      const result = await parseQuickText(text)
      const drafts = result.items.map((item) => {
        const itemName = typeof item.name === 'string' ? normalizeRecentName(item.name) : ''
        const recent = itemName ? this.data.recentProfiles.find((profile) => normalizeRecentName(profile.name) === itemName) : undefined
        return createDraftFromParsed(item, source, this.data.defaultReminderLeadDays, recent, { kind: 'text', sourceText: text })
      })
      this.setData({ recognitionState: 'idle', saveSummary: '' })
      this.commitDrafts(drafts)
      track('quick_parse_result', { result: 'success', durationMs: Date.now() - startedAt, draftCount: drafts.length })
      wx.pageScrollTo({ selector: '#draft-area', duration: 220 })
    } catch (error) {
      this.setData({ recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('quick_parse_result', { result: 'failed', durationMs: Date.now() - startedAt, failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  selectRecent(event: WechatMiniprogram.CustomEvent) {
    if (this.data.saving) return
    const profile = this.data.recentProfiles[Number(event.currentTarget.dataset.index)]
    if (!profile) return
    const draft = createDraftFromRecent(profile, this.data.defaultReminderLeadDays)
    this.setData({ saveSummary: '' })
    this.commitDrafts([draft])
    track('recent_item_select')
    wx.pageScrollTo({ selector: '#draft-area', duration: 220 })
  },

  updateDraft(index: number, mutator: (draft: QuickEntryDraft) => QuickEntryDraft) {
    const current = this.data.drafts[index]
    if (!current || current.status === 'saving' || current.status === 'saved') return
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
    this.updateDraft(index, (draft) => ({ ...draft, fields: { ...draft.fields, [field]: String(event.detail.value) } }))
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
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    this.setData({ voicePressing: true, voiceState: 'authorizing', inputError: '' })
    try {
      await new Promise<void>((resolve, reject) => wx.authorize({ scope: 'scope.record', success: () => resolve(), fail: reject }))
      track('voice_permission_result', { result: 'granted' })
      if (!this.data.voicePressing) {
        this.setData({ voiceState: 'idle' })
        return
      }
      cancelCurrentRecording = false
      recorderManager?.start({ duration: 30000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' })
      this.setData({ voiceState: 'recording' })
    } catch (_error) {
      this.setData({ voiceState: 'idle', voicePressing: false, inputError: '需要麦克风权限才能录音，也可以继续使用文字或完整填写' })
      track('voice_permission_result', { result: 'denied' })
      wx.showModal({ title: '麦克风权限未开启', content: '麦克风只用于本次语音录入，可在设置中开启。', confirmText: '去设置', success: (result) => { if (result.confirm) wx.openSetting() } })
    }
  },

  stopVoice() {
    this.setData({ voicePressing: false })
    if (this.data.voiceState === 'recording') recorderManager?.stop()
  },

  cancelVoice() {
    this.setData({ voicePressing: false })
    if (this.data.voiceState === 'recording') {
      cancelCurrentRecording = true
      recorderManager?.stop()
    }
  },

  async handleRecordedFile(localPath: string) {
    this.setData({ voiceState: 'uploading', recognitionState: 'transcribing', inputError: '' })
    try {
      const fileID = await uploadQuickEntryMedia(localPath, 'audio')
      const result = await transcribeVoice(fileID, 'audio')
      this.setData({ inputText: result.text, voiceState: 'idle', recognitionState: 'idle' })
      track('voice_transcribe_result', { result: 'success' })
      await this.generateDrafts('voice')
    } catch (error) {
      this.setData({ voiceState: 'idle', recognitionState: 'idle', inputError: getErrorMessage(error) })
      track('voice_transcribe_result', { result: 'failed', failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  async chooseDatePhoto() {
    if (this.data.saving || this.data.recognitionState !== 'idle') return
    try {
      const media = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], success: resolve, fail: reject }))
      const localPath = media.tempFiles[0]?.tempFilePath
      if (!localPath) return
      this.setData({ photoPreview: localPath, recognitionState: 'recognizing_photo', inputError: '' }, () => this.syncUnloadPrompt())
      const fileID = await uploadQuickEntryMedia(localPath, 'image')
      const result = await recognizeDatePhoto(fileID, 'image')
      if (result.unsupported === 'opened_period') {
        this.setData({ recognitionState: 'idle', inputError: '当前版本暂不支持“开封后使用期”，请手动选择日期' })
        return
      }
      const current = this.data.drafts[0]
      const item = current ? {
        name: current.fields.name,
        quantity: current.fields.quantity ?? undefined,
        unit: current.fields.unit,
        category: current.fields.category || undefined,
        storageLocation: current.fields.storageLocation,
        expiryInputMode: current.fields.expiryInputMode,
        shelfLifeValue: current.fields.shelfLifeValue ?? undefined,
        shelfLifeUnit: current.fields.shelfLifeUnit ?? undefined,
        dateCandidates: result.candidates,
      } : { dateCandidates: result.candidates }
      const draft = createDraftFromParsed(item, 'date_photo', this.data.defaultReminderLeadDays, undefined, { kind: 'photo', localPath })
      if (current) {
        draft.draftId = current.draftId
        draft.saveKey = current.saveKey
        draft.fields.reminderLeadDays = current.fields.reminderLeadDays
      }
      this.setData({ recognitionState: 'idle' })
      this.commitDrafts([draft])
      track('date_photo_result', { result: 'success', candidateCount: result.candidates.length })
      wx.pageScrollTo({ selector: '#draft-area', duration: 220 })
    } catch (error) {
      const message = getErrorMessage(error)
      if (!message.toLowerCase().includes('cancel')) this.setData({ recognitionState: 'idle', inputError: message })
      else this.setData({ recognitionState: 'idle' })
      track('date_photo_result', { result: 'failed', failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  continueManual() {
    if (this.data.saving) return
    const draft = this.data.drafts.find((item) => item.status !== 'saved')
    const pendingQuickFormDraft: Partial<InventorySaveInput> | null = draft ? {
      name: draft.fields.name,
      quantity: draft.fields.quantity ?? 1,
      unit: draft.fields.unit,
      category: draft.fields.category || 'food',
      storageLocation: draft.fields.storageLocation,
      expiryInputMode: draft.fields.expiryInputMode,
      productionDate: draft.fields.productionDate,
      shelfLifeValue: draft.fields.shelfLifeValue,
      shelfLifeUnit: draft.fields.shelfLifeUnit,
      expiryDate: draft.fields.expiryDate,
      reminderLeadDays: draft.fields.reminderLeadDays ?? 1,
    } : null
    getApp<IAppOption>().globalData.pendingQuickFormDraft = pendingQuickFormDraft
    wx.disableAlertBeforeUnload?.()
    wx.redirectTo({ url: '/pages/item-form/index?source=quick-entry' })
  },

  async saveDrafts() {
    if (this.data.saving) return
    const targets = this.data.drafts.map((draft, index) => ({ draft, index })).filter(({ draft }) => draft.selected && !draft.issues.length && ['savable', 'failed'].includes(draft.status))
    if (!targets.length) return
    const savingDrafts = this.data.drafts.map((draft, index) => targets.some((target) => target.index === index) ? { ...draft, status: 'saving' as const } : draft)
    this.setData({ saving: true, saveSummary: '' })
    this.commitDrafts(savingDrafts)
    const results = await Promise.allSettled(targets.map(({ draft }) => {
      const result = draftToInventoryInput(draft)
      return result.input ? saveItem(result.input, { idempotencyKey: draft.saveKey }) : Promise.reject(new Error('草稿信息不完整'))
    }))
    const updated = [...savingDrafts]
    let succeeded = 0
    let failed = 0
    results.forEach((result, resultIndex) => {
      const target = targets[resultIndex]
      if (result.status === 'fulfilled') {
        updated[target.index] = { ...target.draft, status: 'saved', selected: false }
        succeeded += 1
      } else {
        updated[target.index] = { ...target.draft, status: 'failed', errorMessage: getErrorMessage(result.reason) }
        failed += 1
      }
    })
    this.setData({ saving: false, saveSummary: failed ? `已成功 ${succeeded} 条，失败 ${failed} 条` : '' })
    this.commitDrafts(updated)
    track('quick_entry_save_result', { result: failed ? (succeeded ? 'partial' : 'failed') : 'success', draftCount: targets.length })
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
