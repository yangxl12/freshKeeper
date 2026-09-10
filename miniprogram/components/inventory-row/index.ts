import { parseQuantity, sanitizeQuantityInput } from '../../domain/inventory'

interface CardItem {
  _id?: string
  quantity?: number
  coverFileId?: string
}

const COVER_PLACEHOLDER = '/assets/inventory-placeholder.svg'

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
  },

  methods: {
    emit(eventName: 'select' | 'edit' | 'quantity' | 'more') {
      const item = this.properties.item as CardItem
      if (!item._id) return
      this.triggerEvent(eventName, { itemId: item._id })
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
      this.setData({ editing: true, editValue: String(item.quantity) })
    },

    handleEditInput(event: WechatMiniprogram.Input) {
      this.setData({ editValue: sanitizeQuantityInput(event.detail.value) })
    },

    // 失焦 / 键盘确认即提交：非法输入或没变化就静默还原，有效值交给页面保存。
    commitEdit() {
      if (!this.data.editing) return
      const item = this.properties.item as CardItem
      const quantity = parseQuantity(this.data.editValue)
      this.setData({ editing: false, editValue: '' })
      if (!item._id || quantity === null || quantity === item.quantity) return
      this.triggerEvent('quantityset', { itemId: item._id, quantity })
    },

    handleMore() {
      this.emit('more')
    },
  },
})
