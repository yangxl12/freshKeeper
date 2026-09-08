interface TabBarDataset {
  index?: string | number
  url?: string
}

Component({
  data: {
    selected: 0,
  },

  methods: {
    switchTab(event: WechatMiniprogram.CustomEvent) {
      const dataset = event.currentTarget.dataset as TabBarDataset
      const index = Number(dataset.index)
      const url = dataset.url
      if (!url || Number.isNaN(index)) return
      if (index === this.data.selected) return
      wx.switchTab({ url })
    },

    handleAdd() {
      wx.navigateTo({ url: '/pages/quick-entry/index' })
    },
  },
})
