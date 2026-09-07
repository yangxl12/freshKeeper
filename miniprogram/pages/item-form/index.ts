import {
  CATEGORY_OPTIONS,
  SHELF_LIFE_OPTIONS,
  STORAGE_OPTIONS,
} from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { getItem, saveItem } from '../../services/inventory-service'
import { getSettings } from '../../services/settings-service'
import type {
  Category,
  ExpiryInputMode,
  InventorySaveInput,
  ShelfLifeUnit,
  StorageLocation,
} from '../../types/inventory'
import { track } from '../../utils/analytics'
import { calculateExpiryDate, localTodayKey, parseDateKey } from '../../utils/date-key'

const FORM_CATEGORY_OPTIONS = CATEGORY_OPTIONS.slice(1)
const FORM_STORAGE_OPTIONS = STORAGE_OPTIONS.slice(1)

Page({
  data: {
    itemId: '',
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
    storageOptions: FORM_STORAGE_OPTIONS,
    storageIndex: FORM_STORAGE_OPTIONS.findIndex((option) => option.value === 'other'),
    expiryDate: '',
    productionDate: '',
    shelfLifeValue: '',
    shelfLifeOptions: SHELF_LIFE_OPTIONS,
    shelfLifeUnitIndex: 0,
    reminderLeadDays: '3',
    expiryPreview: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const itemId = options.id || ''
    this.setData({ itemId })
    wx.setNavigationBarTitle({ title: itemId ? '编辑物品' : '新增物品' })
    if (itemId) this.loadItem(itemId)
    else this.loadDefaults()
  },

  async loadDefaults() {
    try {
      const settings = await getSettings()
      const storageIndex = settings.defaultStorageLocation
        ? FORM_STORAGE_OPTIONS.findIndex(
            (option) => option.value === settings.defaultStorageLocation,
          )
        : FORM_STORAGE_OPTIONS.findIndex((option) => option.value === 'other')
      this.setData({
        reminderLeadDays: String(settings.defaultReminderLeadDays),
        storageIndex: storageIndex >= 0 ? storageIndex : 0,
      })
    } catch (_error) {
      // 默认设置读取失败不阻塞录入，继续使用产品默认值。
    }
  },

  async loadItem(itemId: string) {
    this.setData({ loading: true, loadFailed: false, errorMessage: '' })
    try {
      const item = await getItem(itemId)
      const categoryIndex = FORM_CATEGORY_OPTIONS.findIndex(
        (option) => option.value === item.category,
      )
      const storageIndex = FORM_STORAGE_OPTIONS.findIndex(
        (option) => option.value === item.storageLocation,
      )
      const shelfLifeUnitIndex = SHELF_LIFE_OPTIONS.findIndex(
        (option) => option.value === item.shelfLifeUnit,
      )
      this.setData({
        version: item.version,
        mode: item.expiryInputMode,
        name: item.name,
        quantity: String(item.quantity),
        unit: item.unit,
        categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
        storageIndex: storageIndex >= 0 ? storageIndex : 0,
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
      this.setData({
        loading: false,
        loadFailed: true,
        errorMessage: getErrorMessage(error),
      })
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
    const field = event.currentTarget.dataset.field as 'name' | 'quantity' | 'unit' | 'shelfLifeValue' | 'reminderLeadDays'
    this.setData({ [field]: event.detail.value }, () => {
      if (field === 'shelfLifeValue') this.updateExpiryPreview()
    })
  },

  handleCategoryChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ categoryIndex: Number(event.detail.value) })
  },

  handleStorageChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ storageIndex: Number(event.detail.value) })
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
      const value = Number(this.data.shelfLifeValue)
      const unit = SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]?.value
      const expiryPreview = calculateExpiryDate({
        mode: 'shelf_life',
        productionDate: this.data.productionDate,
        shelfLifeValue: value,
        shelfLifeUnit: unit,
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
    } else {
      if (!parseDateKey(this.data.productionDate)) return '请选择有效的生产日期'
      const shelfLifeValue = Number(this.data.shelfLifeValue)
      if (!Number.isInteger(shelfLifeValue) || shelfLifeValue <= 0) {
        return '保质期需为正整数'
      }
      if (!this.data.expiryPreview) return '无法计算到期日期，请检查输入'
    }
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

    const category = FORM_CATEGORY_OPTIONS[this.data.categoryIndex]?.value as Category
    const storageLocation = FORM_STORAGE_OPTIONS[this.data.storageIndex]
      ?.value as StorageLocation
    const shelfLifeUnit = SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]
      ?.value as ShelfLifeUnit
    const input: InventorySaveInput = {
      itemId: this.data.itemId || undefined,
      version: this.data.itemId ? this.data.version : undefined,
      name: this.data.name.trim(),
      quantity: Number(this.data.quantity),
      unit: this.data.unit.trim(),
      category,
      storageLocation,
      expiryInputMode: this.data.mode,
      productionDate: this.data.mode === 'shelf_life' ? this.data.productionDate : null,
      shelfLifeValue:
        this.data.mode === 'shelf_life' ? Number(this.data.shelfLifeValue) : null,
      shelfLifeUnit: this.data.mode === 'shelf_life' ? shelfLifeUnit : null,
      expiryDate: this.data.mode === 'direct' ? this.data.expiryDate : null,
      reminderLeadDays: Number(this.data.reminderLeadDays),
    }

    this.setData({ saving: true, errorMessage: '' })
    try {
      await saveItem(input)
      if (!this.data.itemId) track('item_create_success')
      wx.showToast({ title: this.data.itemId ? '修改成功' : '已加入库存', icon: 'success' })
      wx.navigateBack()
    } catch (error) {
      this.setData({ saving: false, errorMessage: getErrorMessage(error) })
      wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    }
  },

  retryLoad() {
    if (this.data.itemId) this.loadItem(this.data.itemId)
    else this.loadDefaults()
  },
})
