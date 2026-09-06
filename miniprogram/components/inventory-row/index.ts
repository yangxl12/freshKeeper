Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
    history: {
      type: Boolean,
      value: false,
    },
  },
  methods: {
    handleTap() {
      const item = this.properties.item as { _id?: string }
      if (item._id) this.triggerEvent('select', { itemId: item._id })
    },
  },
})
