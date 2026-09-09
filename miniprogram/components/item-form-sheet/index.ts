import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { getItem, restoreItem, saveItem } from '../../services/inventory-service'
import { getSettings } from '../../services/settings-service'
import type {
  Category,
  ExpiryInputMode,
  InventorySaveInput,
  ShelfLifeUnit,
} from '../../types/inventory'
import { track } from '../../utils/analytics'
import { calculateExpiryDate, localTodayKey, parseDateKey } from '../../utils/date-key'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
const LEGACY_STORAGE_LABELS: Record<string, string> = {
  refrigerated: '冷藏',
  frozen: '冷冻',
  cabinet: '橱柜',
  medicine_box: '药箱',
  other: '其他',
}

type FormTextField = 'name' | 'quantity' | 'unit' | 'storageLocation' | 'shelfLifeValue' | 'reminderLeadDays'

/** 完整录入表单；pages/item-form 与「物品录入」的完整录入 tab 共用同一份实现。 */
Component({
  properties: {
    itemId: { type: String, value: '' },
    restore: { type: Boolean, value: false },
    /** quick-entry 表示由快速录入侧发起，保存时沿用草稿的幂等编号。 */
    source: { type: String, value: '' },
    quickSaveKey: { type: String, value: '' },
    prefill: { type: Object, value: null },
  },

  data: {
    originalExpiryDate: '',
    originalCreatedAt: 0,
    version: 0,
    loading: false,
    loadFailed: false,
    saving: false,
    errorMessage: '',
    today: localTodayKey(),
    mode: 'direct' as ExpiryInputMode,
    name: '',
    quantity: '1',
    unit: '件',
    categoryOptions: FORM_CATEGORY_OPTIONS,
    categoryIndex: 0,
    storageLocation: '',
    expiryDate: '',
    productionDate: '',
    shelfLifeValue: '',
    shelfLifeOptions: SHELF_LIFE_OPTIONS,
    shelfLifeUnitIndex: 0,
    reminderLeadDays: '1',
    expiryPreview: '',
  },

  lifetimes: {
    attached() {
      this.start(this.data.prefill as Partial<InventorySaveInput> | null)
    },
  },

  methods: {
    start(pendingDraft: Partial<InventorySaveInput> | null = null) {
      if (this.data.itemId) this.loadItem(this.data.itemId)
      else this.loadDefaults(pendingDraft)
    },

    /** 宿主页面切换到本表单时注入一条快速录入草稿。 */
    applyPrefill(pendingDraft: Partial<InventorySaveInput> | null, saveKey = '') {
      const patch: Record<string, unknown> = { errorMessage: '', loadFailed: false }
      if (saveKey) patch.quickSaveKey = saveKey
      this.setData(patch, () => this.loadDefaults(pendingDraft))
    },

    async loadDefaults(pendingDraft: Partial<InventorySaveInput> | null = null) {
      try {
        const settings = await getSettings()
        this.setData({
          reminderLeadDays: String(pendingDraft?.reminderLeadDays ?? settings.defaultReminderLeadDays),
        })
      } catch (_error) {
        // 默认设置读取失败不阻塞录入，继续使用产品默认值。
      }
      if (!pendingDraft) return
      const categoryIndex = FORM_CATEGORY_OPTIONS.findIndex((option) => option.value === pendingDraft.category)
      const shelfLifeUnitIndex = SHELF_LIFE_OPTIONS.findIndex((option) => option.value === pendingDraft.shelfLifeUnit)
      this.setData({
        name: pendingDraft.name || '',
        quantity: pendingDraft.quantity == null ? '1' : String(pendingDraft.quantity),
        unit: pendingDraft.unit || '件',
        categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
        storageLocation: pendingDraft.storageLocation || '',
        mode: pendingDraft.expiryInputMode || 'direct',
        expiryDate: pendingDraft.expiryDate || '',
        productionDate: pendingDraft.productionDate || '',
        shelfLifeValue: pendingDraft.shelfLifeValue == null ? '' : String(pendingDraft.shelfLifeValue),
        shelfLifeUnitIndex: shelfLifeUnitIndex >= 0 ? shelfLifeUnitIndex : 0,
        reminderLeadDays: String(pendingDraft.reminderLeadDays ?? 1),
      }, () => this.updateExpiryPreview())
    },

    /** 回到空白的新增状态，供保存成功后接着录入下一条。 */
    resetEntry() {
      if (this.data.itemId) return
      this.setData({
        version: 0,
        originalExpiryDate: '',
        originalCreatedAt: 0,
        saving: false,
        errorMessage: '',
        today: localTodayKey(),
        mode: 'direct',
        name: '',
        quantity: '1',
        unit: '件',
        categoryIndex: 0,
        storageLocation: '',
        expiryDate: '',
        productionDate: '',
        shelfLifeValue: '',
        shelfLifeUnitIndex: 0,
        expiryPreview: '',
      })
      this.loadDefaults(null)
    },

    async loadItem(itemId: string) {
      this.setData({ loading: true, loadFailed: false, errorMessage: '' })
      try {
        const item = await getItem(itemId)
        const categoryIndex = FORM_CATEGORY_OPTIONS.findIndex((option) => option.value === item.category)
        const shelfLifeUnitIndex = SHELF_LIFE_OPTIONS.findIndex((option) => option.value === item.shelfLifeUnit)
        this.setData({
          version: item.version,
          originalExpiryDate: item.expiryDate,
          originalCreatedAt: item.createdAt ? new Date(item.createdAt).getTime() : 0,
          mode: item.expiryInputMode,
          name: item.name,
          quantity: String(item.quantity),
          unit: item.unit,
          categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
          storageLocation:
            LEGACY_STORAGE_LABELS[item.storageLocation] ||
            (item.storageLocation ? item.storageLabel : ''),
          expiryDate: item.expiryDate,
          productionDate: item.productionDate || '',
          shelfLifeValue: item.shelfLifeValue ? String(item.shelfLifeValue) : '',
          shelfLifeUnitIndex: shelfLifeUnitIndex >= 0 ? shelfLifeUnitIndex : 0,
          reminderLeadDays: String(item.reminderLeadDays),
          loading: false,
          loadFailed: false,
        })
        this.updateExpiryPreview()
      } catch (error) {
        this.setData({ loading: false, loadFailed: true, errorMessage: getErrorMessage(error) })
      }
    },

    handleModeChange(event: WechatMiniprogram.BaseEvent) {
      const mode = event.currentTarget.dataset.mode as ExpiryInputMode
      if (mode === this.data.mode) return
      this.setData(
        mode === 'direct'
          ? { mode, productionDate: '', shelfLifeValue: '', expiryPreview: '' }
          : { mode, expiryDate: '', expiryPreview: '' },
      )
    },

    handleTextInput(event: WechatMiniprogram.Input) {
      const field = event.currentTarget.dataset.field as FormTextField
      this.setData({ [field]: event.detail.value }, () => {
        if (field === 'shelfLifeValue') this.updateExpiryPreview()
      })
    },

    handleCategoryChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ categoryIndex: Number(event.detail.value) })
    },

    handleShelfLifeUnitChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ shelfLifeUnitIndex: Number(event.detail.value) }, () => {
        this.updateExpiryPreview()
      })
    },

    handleDateChange(event: WechatMiniprogram.PickerChange) {
      const field = event.currentTarget.dataset.field as 'expiryDate' | 'productionDate'
      this.setData({ [field]: String(event.detail.value) }, () => this.updateExpiryPreview())
    },

    updateExpiryPreview() {
      if (this.data.mode !== 'shelf_life') {
        this.setData({ expiryPreview: '' })
        return
      }
      try {
        const expiryPreview = calculateExpiryDate({
          mode: 'shelf_life',
          productionDate: this.data.productionDate,
          shelfLifeValue: Number(this.data.shelfLifeValue),
          shelfLifeUnit: SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]?.value,
        })
        this.setData({ expiryPreview })
      } catch (_error) {
        this.setData({ expiryPreview: '' })
      }
    },

    validateForm(): string {
      const name = this.data.name.trim()
      const quantity = Number(this.data.quantity)
      const unit = this.data.unit.trim()
      const reminderLeadDays = Number(this.data.reminderLeadDays)
      if (!name || name.length > 40) return '物品名称需为 1～40 个字符'
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        return '数量需为 1～9999 的整数'
      }
      if (!unit || unit.length > 8) return '单位需为 1～8 个字符'
      if (!Number.isInteger(reminderLeadDays) || reminderLeadDays < 0 || reminderLeadDays > 30) {
        return '提前提醒需为 0～30 天的整数'
      }
      if (this.data.mode === 'direct') {
        if (!parseDateKey(this.data.expiryDate)) return '请选择有效的到期日期'
        return ''
      }
      if (!parseDateKey(this.data.productionDate)) return '请选择有效的生产日期'
      const shelfLifeValue = Number(this.data.shelfLifeValue)
      if (!Number.isInteger(shelfLifeValue) || shelfLifeValue <= 0) return '保质期需为正整数'
      if (!this.data.expiryPreview) return '无法计算到期日期，请检查输入'
      return ''
    },

    async save() {
      if (this.data.saving) return
      const validationMessage = this.validateForm()
      if (validationMessage) {
        this.setData({ errorMessage: validationMessage })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
        return
      }

      const itemId = this.data.itemId
      const restoring = this.data.restore
      const input: InventorySaveInput = {
        itemId: itemId || undefined,
        version: itemId ? this.data.version : undefined,
        name: this.data.name.trim(),
        quantity: Number(this.data.quantity),
        unit: this.data.unit.trim(),
        category: FORM_CATEGORY_OPTIONS[this.data.categoryIndex]?.value as Category,
        storageLocation: this.data.storageLocation.trim(),
        expiryInputMode: this.data.mode,
        productionDate: this.data.mode === 'shelf_life' ? this.data.productionDate : null,
        shelfLifeValue: this.data.mode === 'shelf_life' ? Number(this.data.shelfLifeValue) : null,
        shelfLifeUnit: (this.data.mode === 'shelf_life'
          ? SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]?.value
          : null) as ShelfLifeUnit,
        expiryDate: this.data.mode === 'direct' ? this.data.expiryDate : null,
        reminderLeadDays: Number(this.data.reminderLeadDays),
      }

      this.setData({ saving: true, errorMessage: '' })
      try {
        if (restoring) await restoreItem(input)
        else await saveItem(input, this.data.source === 'quick-entry' ? { idempotencyKey: this.data.quickSaveKey } : undefined)
        if (!itemId) track('item_create_success')
        const finalExpiryDate = this.data.mode === 'direct' ? this.data.expiryDate : this.data.expiryPreview
        if (itemId && !restoring && finalExpiryDate !== this.data.originalExpiryDate) {
          const age = Date.now() - this.data.originalCreatedAt
          track('item_expiry_corrected', { within24h: this.data.originalCreatedAt > 0 && age >= 0 && age <= 86400000 ? 1 : 0 })
        }
        this.setData({ saving: false })
        this.triggerEvent('saved', {
          restoring,
          itemId,
          source: this.data.source,
          quickSaveKey: this.data.quickSaveKey,
          name: input.name,
          expiryDate: finalExpiryDate,
        })
      } catch (error) {
        this.setData({ saving: false, errorMessage: getErrorMessage(error) })
        wx.pageScrollTo({ scrollTop: 0, duration: 200 })
      }
    },

    retryLoad() {
      if (this.data.itemId) this.loadItem(this.data.itemId)
      else this.loadDefaults(this.data.prefill as Partial<InventorySaveInput> | null)
    },
  },
})
