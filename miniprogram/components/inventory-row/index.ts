interface CardItem {
  _id?: string
  quantity?: number
}

Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
  },

  methods: {
    emit(eventName: 'select' | 'edit' | 'quantity' | 'more') {
      const item = this.properties.item as CardItem
      if (!item._id) return
      this.triggerEvent(eventName, { itemId: item._id })
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

    handleMore() {
      this.emit('more')
    },
  },
})
