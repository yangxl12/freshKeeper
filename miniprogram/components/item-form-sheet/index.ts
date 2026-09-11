import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import { getErrorMessage } from '../../services/cloud-client'
import { getItem, generateItemCover, restoreItem, saveItem } from '../../services/inventory-service'
import { armReminder, requestReminderAuthorization } from '../../services/reminder-service'
import { getSettings } from '../../services/settings-service'
import type {
  Category,
  ExpiryInputMode,
  InventorySaveInput,
  ShelfLifeUnit,
} from '../../types/inventory'
import type { QuickEntryDraftFields } from '../../types/quick-entry'
import { track } from '../../utils/analytics'
import { calculateExpiryDate, localTodayKey, parseDateKey } from '../../utils/date-key'

/** 空字符串或非法数字统一折算成 null，免得把 NaN 塞进草稿。 */
function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

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
    itemId: {
      type: String,
      value: '',
      observer(itemId: string) {
        // 页面 onLoad 的 setData 晚于组件 attached 生效，编辑 id 后到时补一次加载，否则表单停留在空白新增态。
        if (!itemId) return
        this.loadItem(itemId)
      },
    },
    restore: { type: Boolean, value: false },
    /** quick-entry 表示由快速录入侧发起，保存时沿用草稿的幂等编号。 */
    source: { type: String, value: '' },
    quickSaveKey: { type: String, value: '' },
    prefill: { type: Object, value: null },
    /**
     * save（默认）：表单自己写库，用于完整录入、编辑物品和重新入库。
     * draft：表单只把值回传给宿主（快速录入的草稿编辑弹窗），
     *        底部主按钮由宿主持有，本组件不渲染 save-bar。
     */
    purpose: { type: String, value: 'save' },
  },

  data: {
    originalExpiryDate: '',
    originalCreatedAt: 0,
    version: 0,
    loading: false,
    loadFailed: false,
    saving: false,
    errorMessage: '',
    /** 用户是否动过表单；草稿编辑模式下宿主据此决定退出要不要二次确认。 */
    dirty: false,
    /** 宿主是否注入过数据（草稿/待录入物品）；用于让迟到的默认设置回填作废。 */
    prefilled: false,
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
    /**
     * 新增物品时是否在保存成功后顺手开启这一次到期提醒。
     * 只是本地意向，真正的授权在保存成功那一刻才向微信申请。
     */
    remindAfterSave: true,
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
      const patch: Record<string, unknown> = { errorMessage: '', loadFailed: false, dirty: false, prefilled: Boolean(pendingDraft) }
      if (saveKey) patch.quickSaveKey = saveKey
      this.setData(patch, () => this.loadDefaults(pendingDraft))
    },

    async loadDefaults(pendingDraft: Partial<InventorySaveInput> | null = null) {
      try {
        const settings = await getSettings()
        // attached 时 id 尚未到达而先走了默认值加载；等待期间编辑 id 已到、或宿主已灌入草稿
        // （applyPrefill），此时跳过默认提醒天数回填，避免覆盖已经写进表单的数据。
        if (!pendingDraft && (this.data.itemId || this.data.prefilled)) return
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
        dirty: false,
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
        dirty: false,
        prefilled: false,
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
        remindAfterSave: true,
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

    /**
     * 只切 mode，绝不动另一侧的输入：用户来回切换「到期日期 ↔ 保质期计算」时数据必须留住，
     * 之前这里清空对侧字段，导致切回来发现填过的日期没了。
     * 不会串味——save() / collectDraftFields() 都按当前 mode 取字段，未选中侧一律写 null。
     * 切完重算预计到期，让保留的生产日期+保质期立刻恢复预览。
     */
    handleModeChange(event: WechatMiniprogram.BaseEvent) {
      const mode = event.currentTarget.dataset.mode as ExpiryInputMode
      if (mode === this.data.mode) return
      this.setData({ mode, dirty: true }, () => this.updateExpiryPreview())
    },

    handleTextInput(event: WechatMiniprogram.Input) {
      const field = event.currentTarget.dataset.field as FormTextField
      this.setData({ [field]: event.detail.value, dirty: true }, () => {
        if (field === 'shelfLifeValue') this.updateExpiryPreview()
      })
    },

    handleCategoryChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ categoryIndex: Number(event.detail.value), dirty: true })
    },

    /**
     * 「保存后开启提醒」只是本地意向开关，不碰微信授权、不写账号设置。
     * 全局默认天数与通知授权都只在「我的—提醒设置」里改，本表单不再提供第二入口。
     */
    toggleRemindAfterSave() {
      this.setData({ remindAfterSave: !this.data.remindAfterSave })
    },

    handleShelfLifeUnitChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ shelfLifeUnitIndex: Number(event.detail.value), dirty: true }, () => {
        this.updateExpiryPreview()
      })
    },

    handleDateChange(event: WechatMiniprogram.PickerChange) {
      const field = event.currentTarget.dataset.field as 'expiryDate' | 'productionDate'
      this.setData({ [field]: String(event.detail.value), dirty: true }, () => this.updateExpiryPreview())
    },

    /** 草稿编辑模式下宿主用来判断退出要不要二次确认。 */
    isDirty(): boolean {
      return this.data.dirty === true
    },

    /**
     * 草稿编辑模式回传的字段：与快速录入草稿的字段一一对应，空值统一折算成 null，
     * 好让宿主直接用 refreshDraftValidation 重算状态。
     */
    collectDraftFields(): QuickEntryDraftFields {
      const mode = this.data.mode
      const isShelfLife = mode === 'shelf_life'
      // 选项表已去掉空分类，这里的 value 一定是合法分类。
      const category = FORM_CATEGORY_OPTIONS[this.data.categoryIndex]?.value as Category | undefined
      return {
        name: this.data.name,
        quantity: toNumberOrNull(this.data.quantity),
        unit: this.data.unit,
        category: category || null,
        storageLocation: this.data.storageLocation,
        expiryInputMode: mode,
        productionDate: isShelfLife ? (this.data.productionDate || null) : null,
        shelfLifeValue: isShelfLife ? toNumberOrNull(this.data.shelfLifeValue) : null,
        shelfLifeUnit: isShelfLife ? (SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]?.value ?? null) : null,
        expiryDate: isShelfLife ? null : (this.data.expiryDate || null),
        reminderLeadDays: toNumberOrNull(this.data.reminderLeadDays),
      }
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
        return '提醒天数需为 0～30 的整数'
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
      // 草稿编辑模式：只把表单值交回宿主，落库由快速录入的「加入库存」决定。
      // 这里不做阻断式校验——草稿状态由 domain 的 refreshDraftValidation 统一重算，
      // 否则缺日期的草稿会被表单锁在里面出不去。
      if (this.data.purpose === 'draft') {
        this.triggerEvent('draftsubmit', this.collectDraftFields())
        return
      }
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
        let savedItemId = itemId
        if (restoring) await restoreItem(input)
        else {
          const saved = await saveItem(input, this.data.source === 'quick-entry' ? { idempotencyKey: this.data.quickSaveKey } : undefined)
          savedItemId = saved.itemId
          // 新增物品后异步生成 AI 封面：不等待结果，失败保持默认占位图。
          if (!itemId) void generateItemCover(saved.itemId).catch(() => {})
        }
        if (!itemId) track('item_create_success')
        const finalExpiryDate = this.data.mode === 'direct' ? this.data.expiryDate : this.data.expiryPreview
        if (itemId && !restoring && finalExpiryDate !== this.data.originalExpiryDate) {
          const age = Date.now() - this.data.originalCreatedAt
          track('item_expiry_corrected', { within24h: this.data.originalCreatedAt > 0 && age >= 0 && age <= 86400000 ? 1 : 0 })
        }
        this.setData({ saving: false })
        // 顺手开启这一次提醒：只在新增路径做，且必须在 triggerEvent 之前——
        // 宿主收到 saved 会跳转或重置表单，之后再弹订阅授权会被打断。
        if (!itemId && !restoring && this.data.remindAfterSave) {
          await this.armReminderAfterSave(savedItemId, finalExpiryDate)
        }
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

    /**
     * 保存成功后开启这一次到期提醒。
     * 微信一次性订阅：一次同意换一条额度、发完即失效，所以授权只在这一刻申请，
     * 不做常开开关。整段失败都只提示不回滚——物品已经入库，提醒是附加动作。
     */
    async armReminderAfterSave(savedItemId: string, expiryDate: string) {
      if (!savedItemId) return
      if (expiryDate && expiryDate < this.data.today) {
        wx.showToast({ title: '已过期，不提醒', icon: 'none' })
        return
      }
      try {
        const accepted = await requestReminderAuthorization()
        // 用户拒绝授权时 reminder-service 已经给过提示，这里不再叠一层。
        if (!accepted) return
        await armReminder(savedItemId)
        wx.showToast({ title: '提醒已开启', icon: 'success' })
      } catch (_error) {
        wx.showToast({ title: '提醒未能开启', icon: 'none' })
      }
    },

    retryLoad() {
      if (this.data.itemId) this.loadItem(this.data.itemId)
      else this.loadDefaults(this.data.prefill as Partial<InventorySaveInput> | null)
    },
  },
})
