interface CardItem {
  _id?: string
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
      this.triggerEvent('quantity', { itemId: item._id, delta: Number(event.currentTarget.dataset.delta) || 0 })
    },

    handleMore() {
      this.emit('more')
    },
  },
})
