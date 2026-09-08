import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import {
  createDraftFromRecent,
  draftToInventoryInput,
  getDraftSummary,
  getExpirySummary,
  refreshDraftValidation,
} from '../../domain/quick-entry'
import { getErrorMessage, CloudServiceError } from '../../services/cloud-client'
import { saveItem } from '../../services/inventory-service'
import { listRecentProfiles } from '../../services/quick-entry-service'
import type { InventorySaveInput, ShelfLifeUnit } from '../../types/inventory'
import type { QuickEntryDraft, QuickEntryDraftFields, RecentItemProfile } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { QUICK_ENTRY_FEATURES } from '../../config/runtime'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)

Page({
  data: {
    loading: true,
    loadingError: '',
    recentProfiles: [] as RecentItemProfile[],
    drafts: [] as QuickEntryDraft[],
    categoryOptions: FORM_CATEGORY_OPTIONS,
    shelfLifeOptions: SHELF_LIFE_OPTIONS,
    features: QUICK_ENTRY_FEATURES,
    saving: false,
    draftSummary: '',
    expirySummary: '',
  },

  onLoad() {
    track('quick_entry_open')
    if (!QUICK_ENTRY_FEATURES.recent) {
      this.openManual()
      return
    }
    void this.loadRecentProfiles()
  },

  async loadRecentProfiles() {
    try {
      const result = await listRecentProfiles()
      if (!result.items.length && !QUICK_ENTRY_FEATURES.text && !QUICK_ENTRY_FEATURES.voice && !QUICK_ENTRY_FEATURES.datePhoto) {
        this.openManual()
        return
      }
      this.setData({ loading: false, recentProfiles: result.items })
    } catch (error) {
      if (error instanceof CloudServiceError && error.code === 'INVALID_ACTION') {
        this.openManual()
        return
      }
      this.setData({ loading: false, loadingError: '最近物品暂时不可用，请直接完整填写' })
    }
  },

  selectRecent(event: WechatMiniprogram.CustomEvent) {
    const index = Number(event.currentTarget.dataset.index)
    const profile = this.data.recentProfiles[index]
    if (!profile || this.data.drafts.length) return
    const draft = createDraftFromRecent(profile)
    this.setData(
      {
        drafts: [draft],
        draftSummary: getDraftSummary(draft),
        expirySummary: getExpirySummary(draft),
      },
      () => wx.pageScrollTo({ selector: '#draft-area', duration: 220 }),
    )
    track('recent_item_select')
  },

  updateDraft(mutator: (draft: QuickEntryDraft) => QuickEntryDraft) {
    const current = this.data.drafts[0]
    if (!current || current.status === 'saving' || current.status === 'saved') return
    const draft = refreshDraftValidation(mutator(current))
    this.setData({
      drafts: [draft],
      draftSummary: getDraftSummary(draft),
      expirySummary: getExpirySummary(draft),
    })
  },

  handleTextInput(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field as keyof Pick<QuickEntryDraftFields, 'name' | 'quantity' | 'unit' | 'storageLocation' | 'shelfLifeValue' | 'reminderLeadDays'>
    const rawValue = event.detail.value
    const value = ['quantity', 'shelfLifeValue', 'reminderLeadDays'].includes(field)
      ? (rawValue ? Number(rawValue) : null)
      : rawValue
    this.updateDraft((draft) => ({
      ...draft,
      confirmationFields: field === 'quantity'
        ? (draft.confirmationFields || []).filter((item) => item !== field)
        : draft.confirmationFields,
      fields: { ...draft.fields, [field]: value },
    }))
  },

  handleCategoryChange(event: WechatMiniprogram.PickerChange) {
    const category = FORM_CATEGORY_OPTIONS[Number(event.detail.value)]?.value
    if (!category) return
    this.updateDraft((draft) => ({ ...draft, fields: { ...draft.fields, category } }))
  },

  handleShelfLifeUnitChange(event: WechatMiniprogram.PickerChange) {
    const shelfLifeUnit = SHELF_LIFE_OPTIONS[Number(event.detail.value)]?.value as ShelfLifeUnit | undefined
    if (!shelfLifeUnit) return
    this.updateDraft((draft) => ({ ...draft, fields: { ...draft.fields, shelfLifeUnit } }))
  },

  handleDateChange(event: WechatMiniprogram.PickerChange) {
    const field = event.currentTarget.dataset.field as 'expiryDate' | 'productionDate'
    const value = String(event.detail.value)
    this.updateDraft((draft) => ({ ...draft, fields: { ...draft.fields, [field]: value } }))
  },

  handleModeChange(event: WechatMiniprogram.BaseEvent) {
    const mode = event.currentTarget.dataset.mode as QuickEntryDraftFields['expiryInputMode']
    this.updateDraft((draft) => ({
      ...draft,
      fields: {
        ...draft.fields,
        expiryInputMode: mode,
        expiryDate: mode === 'direct' ? draft.fields.expiryDate : null,
        productionDate: mode === 'shelf_life' ? draft.fields.productionDate : null,
      },
    }))
  },

  toggleSelected() {
    this.updateDraft((draft) => ({ ...draft, selected: !draft.selected }))
  },

  removeDraft() {
    this.setData({ drafts: [], draftSummary: '', expirySummary: '' })
  },

  continueManual() {
    const draft = this.data.drafts[0]
    const pendingQuickFormDraft: Partial<InventorySaveInput> | null = draft
      ? {
          name: draft.fields.name,
          quantity: draft.fields.quantity || 1,
          unit: draft.fields.unit,
          category: draft.fields.category || 'food',
          storageLocation: draft.fields.storageLocation,
          expiryInputMode: draft.fields.expiryInputMode,
          productionDate: draft.fields.productionDate,
          shelfLifeValue: draft.fields.shelfLifeValue,
          shelfLifeUnit: draft.fields.shelfLifeUnit,
          expiryDate: draft.fields.expiryDate,
          reminderLeadDays: draft.fields.reminderLeadDays || 1,
        }
      : null
    getApp<IAppOption>().globalData.pendingQuickFormDraft = pendingQuickFormDraft
    wx.navigateTo({ url: '/pages/item-form/index' })
  },

  async saveDraft() {
    const draft = this.data.drafts[0]
    if (!draft || !draft.selected || this.data.saving) return
    const result = draftToInventoryInput(draft)
    if (!result.input) {
      this.setData({ drafts: [refreshDraftValidation(draft)] })
      return
    }
    this.setData({ saving: true, drafts: [{ ...draft, status: 'saving' }], loadingError: '' })
    try {
      await saveItem(result.input, { idempotencyKey: draft.saveKey })
      const savedDraft = { ...draft, status: 'saved' as const }
      this.setData({ saving: false, drafts: [savedDraft] })
      track('quick_entry_save_result', { result: 'success', draftCount: 1 })
      wx.showToast({ title: '已加入库存', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      const message = getErrorMessage(error)
      this.setData({
        saving: false,
        drafts: [{ ...draft, status: 'failed', errorMessage: message }],
      })
      track('quick_entry_save_result', { result: 'failed', draftCount: 1, failureCode: error instanceof CloudServiceError ? error.code : 'UNKNOWN' })
    }
  },

  openManual() {
    wx.redirectTo({ url: '/pages/item-form/index' })
  },
})
