import { CATEGORY_OPTIONS, SHELF_LIFE_OPTIONS } from '../../domain/inventory'
import { resolveReminderTime } from '../../domain/reminder-time'
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

/** 宿主注入的预填值：完整录入字段。 */
type FormPrefill = Partial<InventorySaveInput>

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
    /** 只读派生值：到期日往前推 N 天、当天 09:30。保存时云端按同一规则落 remindDate。 */
    reminderAtText: '',
    reminderMissed: false,
    /** 编辑既有物品时读到的提醒任务状态，决定要不要重新申请一次订阅授权。 */
    reminderStatus: null as string | null,
    expiryPreview: '',
  },

  lifetimes: {
    attached() {
      this.start(this.data.prefill as FormPrefill | null)
    },
  },

  methods: {
    start(pendingDraft: FormPrefill | null = null) {
      if (this.data.itemId) this.loadItem(this.data.itemId)
      else this.loadDefaults(pendingDraft)
    },

    /** 宿主页面切换到本表单时注入一条快速录入草稿。 */
    applyPrefill(pendingDraft: FormPrefill | null, saveKey = '') {
      const patch: Record<string, unknown> = { errorMessage: '', loadFailed: false, dirty: false, prefilled: Boolean(pendingDraft) }
      if (saveKey) patch.quickSaveKey = saveKey
      this.setData(patch, () => this.loadDefaults(pendingDraft))
    },

    async loadDefaults(pendingDraft: FormPrefill | null = null) {
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
      }, () => this.refreshDerived())
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
        reminderAtText: '',
        reminderMissed: false,
        reminderStatus: null,
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
          reminderStatus: item.reminderStatus || null,
          loading: false,
          loadFailed: false,
        })
        this.refreshDerived()
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
      this.setData({ mode, dirty: true }, () => this.refreshDerived())
    },

    handleTextInput(event: WechatMiniprogram.Input) {
      const field = event.currentTarget.dataset.field as FormTextField
      const value = event.detail.value
      // 保质期与提前天数都会改变派生值（到期日预览、提醒时间）。
      // 之前是「先 setData 字段、回调里再刷两次派生值」＝ 每敲一个字符 3 次 setData；
      // 派生值就是字段的函数，先写进 data 再一次性算完下发即可。
      if (field !== 'shelfLifeValue' && field !== 'reminderLeadDays') {
        this.setData({ [field]: value, dirty: true })
        return
      }
      this.data[field as 'shelfLifeValue' | 'reminderLeadDays'] = value
      this.setData({ [field]: value, dirty: true, ...this.derivedPatch() })
    },

    handleCategoryChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ categoryIndex: Number(event.detail.value), dirty: true })
    },

    handleShelfLifeUnitChange(event: WechatMiniprogram.PickerChange) {
      this.setData({ shelfLifeUnitIndex: Number(event.detail.value), dirty: true }, () => {
        this.refreshDerived()
      })
    },

    handleDateChange(event: WechatMiniprogram.PickerChange) {
      const field = event.currentTarget.dataset.field as 'expiryDate' | 'productionDate'
      this.setData({ [field]: String(event.detail.value), dirty: true }, () => this.refreshDerived())
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

    /** 当前生效的到期日：直填模式用输入值，保质期模式用算出来的预览值。 */
    currentExpiryDate(): string {
      return this.data.mode === 'shelf_life' ? this.data.expiryPreview : this.data.expiryDate
    },

    /**
     * 两个派生字段一次算完、一次下发。
     * 原来 refreshDerived = updateExpiryPreview + updateReminderAt 是两次 setData，
     * 叠上 handleTextInput 自己的那次，敲一个字符就是 3 次 setData。
     */
    refreshDerived() {
      this.setData(this.derivedPatch())
    },

    /** 派生值的纯计算部分，不做任何 setData，便于与调用方的字段写入合并成一次下发。 */
    derivedPatch() {
      const preview = this.computeExpiryPreview()
      const reminder = resolveReminderTime({
        expiryDate: this.data.mode === 'shelf_life' ? preview : this.data.expiryDate,
        reminderLeadDays: toNumberOrNull(this.data.reminderLeadDays),
      })
      return {
        expiryPreview: preview,
        reminderAtText: reminder?.text || '',
        reminderMissed: reminder?.missed || false,
      }
    },

    updateReminderAt() {
      const reminder = resolveReminderTime({
        expiryDate: this.currentExpiryDate(),
        reminderLeadDays: toNumberOrNull(this.data.reminderLeadDays),
      })
      this.setData({
        reminderAtText: reminder?.text || '',
        reminderMissed: reminder?.missed || false,
      })
    },

    computeExpiryPreview(): string {
      if (this.data.mode !== 'shelf_life') return ''
      try {
        return calculateExpiryDate({
          mode: 'shelf_life',
          productionDate: this.data.productionDate,
          shelfLifeValue: Number(this.data.shelfLifeValue),
          shelfLifeUnit: SHELF_LIFE_OPTIONS[this.data.shelfLifeUnitIndex]?.value,
        })
      } catch (_error) {
        return ''
      }
    },

    updateExpiryPreview() {
      const expiryPreview = this.computeExpiryPreview()
      // 值没变就不下发：mode 不是 shelf_life 时每次都会算成空串，原来是照发不误。
      if (this.data.expiryPreview === expiryPreview) return
      this.setData({ expiryPreview })
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
        const finalExpiryDate = this.currentExpiryDate()
        if (itemId && !restoring && finalExpiryDate !== this.data.originalExpiryDate) {
          const age = Date.now() - this.data.originalCreatedAt
          track('item_expiry_corrected', { within24h: this.data.originalCreatedAt > 0 && age >= 0 && age <= 86400000 ? 1 : 0 })
        }
        this.setData({ saving: false })
        // 到期提醒默认全部走订阅消息，这里不再问用户要不要开。
        // 编辑已预约/已发送的物品不再重复申请授权，避免每次改个数量都弹一次。
        if (restoring || this.needsReminderArm()) {
          // 授权弹窗必须排在 triggerEvent 之前——宿主收到 saved 会跳转或重置表单，之后弹会被打断。
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
     * 编辑既有物品时要不要为它重新申请一次订阅授权。
     *
     * 微信一次性订阅「一次同意换一条额度」，所以只有真正缺额度的情况才值得打扰用户：
     * 没有预约、上次发送失败、被取消。已预约（额度在手）与已发送（终态）都直接跳过。
     */
    needsReminderArm(): boolean {
      const status = this.data.reminderStatus
      return !status || status === 'failed' || status === 'cancelled'
    },

    /**
     * 保存成功后预约这一次到期提醒。
     *
     * 只按「提醒日 < 今天」做拦截（当天 09:30 是否已过交给云端判定，它会返回 missed 且不落任务）：
     * 前端拿着真实时钟做判断会让行为随运行时刻漂移，日期口径才和表单里「今天」一致。
     * 整段失败都静默处理——物品已经入库，提醒是附加动作，失败不该盖过保存成功的结果。
     */
    async armReminderAfterSave(savedItemId: string, expiryDate: string) {
      if (!savedItemId) return
      const reminder = resolveReminderTime({
        expiryDate,
        reminderLeadDays: toNumberOrNull(this.data.reminderLeadDays),
      })
      if (!reminder || reminder.date < this.data.today) return
      try {
        const accepted = await requestReminderAuthorization()
        // 用户拒绝授权时 reminder-service 已经给过提示，这里不再叠一层。
        if (!accepted) return
        await armReminder(savedItemId)
      } catch (_error) {
        // 附加动作，失败不改动表单状态。
      }
    },

    retryLoad() {
      if (this.data.itemId) this.loadItem(this.data.itemId)
      else this.loadDefaults(this.data.prefill as FormPrefill | null)
    },
  },
})
