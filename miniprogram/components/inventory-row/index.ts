import { parseQuantity, sanitizeQuantityInput } from '../../domain/inventory'

interface CardItem {
  _id?: string
  quantity?: number
  coverFileId?: string
}

const COVER_PLACEHOLDER = '/assets/inventory-placeholder.svg'

// 数量输入框的宽度档位（rpx）：1 位起步，每多一位加宽一档（input 的 maxlength 是 4）。
const QUANTITY_INPUT_BASE_WIDTH = 56
const QUANTITY_INPUT_DIGIT_WIDTH = 20
const QUANTITY_INPUT_MAX_LENGTH = 4

/**
 * 输入框宽度跟着字数走。编辑态里 ± 按钮会让位（见 item-card__stepper--editing），
 * 这里再把宽度撑到刚好放得下内容——固定 flex 宽度在 4 位数下只剩一条缝，根本看不清。
 */
function quantityInputWidth(value: string): number {
  const length = Math.min(String(value ?? '').length, QUANTITY_INPUT_MAX_LENGTH)
  return QUANTITY_INPUT_BASE_WIDTH + Math.max(0, length - 1) * QUANTITY_INPUT_DIGIT_WIDTH
}

Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
  },

  data: {
    coverFor: '',
    coverSrc: COVER_PLACEHOLDER,
    coverError: false,
    editing: false,
    editValue: '',
    // 编辑态输入框宽度（rpx），随输入字数变化。
    editInputWidth: QUANTITY_INPUT_BASE_WIDTH,
    // 数量成功变化时的轻量动效：'' 无动效，其余是加在数字上的 class。
    quantityFlash: '',
    // 上一次渲染的数量，用来判断变化方向（-1 表示还没拿到真实数量）。
    lastQuantity: -1,
    // 读屏播报文本：内容每次不同，屏幕阅读器才会重新念一遍。
    quantityA11yText: '',
  },

  observers: {
    item(item: CardItem) {
      const cover = item && item.coverFileId ? String(item.coverFileId) : ''
      if (cover !== this.data.coverFor) {
        // 换了封面：重置错误态重新加载；没有封面则回到占位图。
        this.setData({ coverFor: cover, coverSrc: cover || COVER_PLACEHOLDER, coverError: false })
        return
      }
      const nextSrc = cover || COVER_PLACEHOLDER
      if (!this.data.coverError && this.data.coverSrc !== nextSrc) {
        this.setData({ coverSrc: nextSrc })
      }
    },

    // 数量真的落库了才提示：失败时 patchItem 不执行，数字不动也就不该有反馈。
    'item.quantity'(quantity: number) {
      const next = Number(quantity)
      if (!Number.isInteger(next)) return
      const prev = this.data.lastQuantity
      this.setData({ lastQuantity: next })
      if (prev < 0 || next === prev) return
      this.flashQuantity(next > prev ? 'up' : 'down', next)
    },
  },

  methods: {
    emit(eventName: 'select' | 'edit' | 'quantity' | 'more') {
      const item = this.properties.item as CardItem
      if (!item._id) return
      this.triggerEvent(eventName, { itemId: item._id })
    },

    // 先摘掉 class 再下一帧加回去，连续点按也能重放动画（同一 class 挂着不会重启）。
    flashQuantity(tone: 'up' | 'down', quantity: number) {
      // 动效只对看得见的人有效：补一次轻震动，读屏用户由隐藏的 live 文本播报。
      // 不支持的机型走 fail 分支，静默即可，不能影响主流程。
      wx.vibrateShort({ type: 'light', fail: () => {} })
      this.setData({ quantityFlash: '', quantityA11yText: `数量已改为 ${quantity}` })
      wx.nextTick(() => {
        this.setData({ quantityFlash: `item-card__quantity-value--${tone}` })
      })
    },

    // 封面加载失败（文件被清理/临时链接失效）→ 回退默认占位图，同一封面不再反复重试。
    handleCoverError() {
      if (this.data.coverError || this.data.coverSrc === COVER_PLACEHOLDER) return
      this.setData({ coverSrc: COVER_PLACEHOLDER, coverError: true })
    },

    handleTap() {
      this.emit('select')
    },

    handleEdit() {
      this.emit('edit')
    },

    handleQuantity(event: WechatMiniprogram.CustomEvent) {
      const item = this.properties.item as CardItem
      if (!item._id) return
      const delta = Number(event.currentTarget.dataset.delta) || 0
      const quantity = Number(item.quantity) || 0
      if (delta < 0 && quantity <= 1) return
      if (delta > 0 && quantity >= 9999) return
      this.triggerEvent('quantity', { itemId: item._id, delta })
    },

    // 点击数字 → 原地进入编辑态（输入框自动聚焦），不再弹窗。
    handleQuantityTap() {
      if (this.data.editing) return
      const item = this.properties.item as CardItem
      if (!item._id || !item.quantity) return
      const editValue = String(item.quantity)
      this.setData({ editing: true, editValue, editInputWidth: quantityInputWidth(editValue) })
    },

    handleEditInput(event: WechatMiniprogram.Input) {
      const editValue = sanitizeQuantityInput(event.detail.value)
      this.setData({ editValue, editInputWidth: quantityInputWidth(editValue) })
    },

    // 失焦 / 键盘确认即提交：非法输入或没变化就静默还原，有效值交给页面保存。
    commitEdit() {
      if (!this.data.editing) return
      const item = this.properties.item as CardItem
      const quantity = parseQuantity(this.data.editValue)
      this.setData({
        editing: false,
        editValue: '',
        editInputWidth: QUANTITY_INPUT_BASE_WIDTH,
      })
      if (!item._id || quantity === null || quantity === item.quantity) return
      this.triggerEvent('quantityset', { itemId: item._id, quantity })
    },

    handleMore() {
      this.emit('more')
    },
  },
})
